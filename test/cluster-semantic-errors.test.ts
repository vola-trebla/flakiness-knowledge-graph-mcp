import { describe, expect, it } from "vitest";
import { clusterErrors, normalizeError, classifyError } from "../src/clustering.js";

const TS = 1_700_000_000_000;

function failure(error: string, test_id = "test-1", timestamp = TS) {
  return { error, test_id, timestamp };
}

describe("normalizeError", () => {
  it("strips numeric IDs from attribute values", () => {
    expect(normalizeError('button[id="submit-user-49284"]')).toBe('button[id="submit-user-<num>"]');
    expect(normalizeError('button[id="submit-user-91823"]')).toBe('button[id="submit-user-<num>"]');
  });

  it("strips UUIDs", () => {
    const a = normalizeError("element 550e8400-e29b-41d4-a716-446655440000 not found");
    const b = normalizeError("element 6ba7b810-9dad-11d1-80b4-00c04fd430c8 not found");
    expect(a).toBe(b);
  });

  it("strips long hex hashes", () => {
    const a = normalizeError("resource abcdef1234567890abcdef1234567890 missing");
    const b = normalizeError("resource 1234567890abcdef1234567890abcdef missing");
    expect(a).toBe(b);
  });

  it("strips URLs", () => {
    const a = normalizeError("failed to load https://cdn.example.com/asset-v2.js");
    const b = normalizeError("failed to load https://cdn.example.com/asset-v3.js");
    expect(a).toBe(b);
  });

  it("normalises whitespace", () => {
    expect(normalizeError("  foo   bar  ")).toBe("foo bar");
  });
});

describe("classifyError", () => {
  it("classifies timeout errors", () => {
    expect(classifyError("Timeout 30000ms exceeded")).toBe("TimeoutError");
  });

  it("classifies assertion errors", () => {
    expect(classifyError("expect(received).toBe(expected)")).toBe("AssertionError");
  });

  it("classifies network errors", () => {
    expect(classifyError("net::ERR_CONNECTION_REFUSED")).toBe("NetworkError");
  });

  it("classifies reference errors", () => {
    expect(classifyError("ReferenceError: myVar is not defined")).toBe("ReferenceError");
  });

  it("falls back to UnknownError", () => {
    expect(classifyError("something completely different")).toBe("UnknownError");
  });
});

describe("clusterErrors", () => {
  it("returns empty for no failures", () => {
    expect(clusterErrors([])).toHaveLength(0);
  });

  it("merges errors that differ only in dynamic numeric IDs", () => {
    const failures = [
      failure('Locator: button[id="submit-user-49284"] not found'),
      failure('Locator: button[id="submit-user-91823"] not found', "test-2"),
      failure('Locator: button[id="submit-user-11111"] not found', "test-3"),
    ];
    const clusters = clusterErrors(failures);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].instance_count).toBe(3);
    expect(clusters[0].affected_tests).toBe(3);
    expect(clusters[0].error_taxonomy).toBe("UnknownError");
  });

  it("keeps genuinely different errors as separate clusters", () => {
    const failures = [
      failure("Timeout 30000ms exceeded waiting for locator"),
      failure("net::ERR_CONNECTION_REFUSED http://localhost:3000", "test-2"),
    ];
    const clusters = clusterErrors(failures);
    expect(clusters).toHaveLength(2);
  });

  it("merges near-duplicate messages via Levenshtein", () => {
    // Differ only in a single word after normalization
    const failures = [
      failure("Expected value to equal foo", "test-1"),
      failure("Expected value to equal bar", "test-2"),
    ];
    const clusters = clusterErrors(failures);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].instance_count).toBe(2);
  });

  it("sets cluster_id as cluster-N ranked by instance count", () => {
    const failures = [
      failure("timeout error A", "t1"),
      failure("timeout error B", "t2"), // merges with A via Levenshtein
      failure("completely different error X Y Z", "t3"),
      failure("completely different error X Y Z", "t4"),
      failure("completely different error X Y Z", "t5"),
    ];
    const clusters = clusterErrors(failures);
    // Largest cluster should be cluster-1
    expect(clusters[0].cluster_id).toBe("cluster-1");
    expect(clusters[0].instance_count).toBeGreaterThanOrEqual(clusters[1].instance_count);
  });

  it("caps sample_test_ids at 5", () => {
    const failures = Array.from({ length: 8 }, (_, i) =>
      failure('button[id="x-<num>"] timeout', `test-${i}`)
    );
    const clusters = clusterErrors(failures);
    expect(clusters[0].sample_test_ids.length).toBeLessThanOrEqual(5);
  });

  it("tracks last_seen as the most recent timestamp", () => {
    const failures = [
      failure("timeout error", "t1", TS),
      failure("timeout error", "t2", TS + 1000),
      failure("timeout error", "t3", TS + 500),
    ];
    const clusters = clusterErrors(failures);
    expect(clusters[0].last_seen).toBe(TS + 1000);
  });

  it("includes normalized_message in output", () => {
    const failures = [failure('button[id="submit-99999"] not found')];
    const clusters = clusterErrors(failures);
    expect(clusters[0].normalized_message).toContain("<num>");
    expect(clusters[0].normalized_message).not.toMatch(/\d{5}/);
  });
});
