import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { insertRun } from "../src/db.js";
import { correlateGitCommitFlakiness } from "../src/db.js";

let testDir: string;
let dbPath: string;

const BASE_TS = 1_700_000_000_000;
const DAY = 86_400_000;

async function seed(
  path: string,
  runs: Array<{
    test_id: string;
    title?: string;
    status: "passed" | "failed" | "flaky";
    day: number;
    sha?: string;
    branch?: string;
    author?: string;
  }>
) {
  for (const r of runs) {
    await insertRun(path, {
      test_id: r.test_id,
      title: r.title ?? r.test_id,
      suite: "suite",
      file: "test.spec.ts",
      status: r.status,
      duration_ms: 100,
      browser: "chromium",
      os: "linux",
      timestamp: BASE_TS + r.day * DAY,
      retry: 0,
      git_commit_sha: r.sha ?? null,
      git_branch: r.branch ?? null,
      git_author: r.author ?? null,
    });
  }
}

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), "flakiness-git-test-"));
  dbPath = join(testDir, "test.db");
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("correlateGitCommitFlakiness", () => {
  it("returns empty when DB has no runs", async () => {
    const emptyDb = join(testDir, "empty.db");
    const result = await correlateGitCommitFlakiness(emptyDb);
    expect(result).toHaveLength(0);
  });

  it("detects stable_to_flaky transition", async () => {
    const db = join(testDir, "stable-to-flaky.db");
    await seed(db, [
      { test_id: "t1", status: "passed", day: 0, sha: "aaa111" },
      { test_id: "t1", status: "passed", day: 1, sha: "aaa222" },
      { test_id: "t1", status: "passed", day: 2, sha: "aaa333" },
      { test_id: "t1", status: "failed", day: 3, sha: "bbb444", branch: "main", author: "alice" },
    ]);

    const result = await correlateGitCommitFlakiness(db, { minStableRuns: 3 });
    expect(result).toHaveLength(1);
    expect(result[0].transition_type).toBe("stable_to_flaky");
    expect(result[0].git_commit_sha).toBe("bbb444");
    expect(result[0].git_branch).toBe("main");
    expect(result[0].git_author).toBe("alice");
    expect(result[0].test_id).toBe("t1");
  });

  it("detects flaky_to_stable transition", async () => {
    const db = join(testDir, "flaky-to-stable.db");
    await seed(db, [
      { test_id: "t2", status: "failed", day: 0, sha: "fail1" },
      { test_id: "t2", status: "failed", day: 1, sha: "fail2", author: "bob" },
      { test_id: "t2", status: "passed", day: 2, sha: "fix1" },
      { test_id: "t2", status: "passed", day: 3, sha: "fix2" },
      { test_id: "t2", status: "passed", day: 4, sha: "fix3" },
    ]);

    const result = await correlateGitCommitFlakiness(db, { minStableRuns: 3 });
    const stable = result.find((r) => r.transition_type === "flaky_to_stable");
    expect(stable).toBeDefined();
    expect(stable!.git_commit_sha).toBe("fail2");
    expect(stable!.git_author).toBe("bob");
  });

  it("does not flag transition when stable run count is below threshold", async () => {
    const db = join(testDir, "below-threshold.db");
    await seed(db, [
      { test_id: "t3", status: "passed", day: 0 },
      { test_id: "t3", status: "passed", day: 1 }, // only 2 passes, threshold is 3
      { test_id: "t3", status: "failed", day: 2, sha: "xyz" },
    ]);

    const result = await correlateGitCommitFlakiness(db, { minStableRuns: 3 });
    expect(result).toHaveLength(0);
  });

  it("includes transition_date as ISO date string", async () => {
    const db = join(testDir, "date-check.db");
    await seed(db, [
      { test_id: "t4", status: "passed", day: 0 },
      { test_id: "t4", status: "passed", day: 1 },
      { test_id: "t4", status: "passed", day: 2 },
      { test_id: "t4", status: "failed", day: 3, sha: "abc" },
    ]);

    const result = await correlateGitCommitFlakiness(db, { minStableRuns: 3 });
    expect(result[0].transition_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("handles null git fields gracefully", async () => {
    const db = join(testDir, "no-git.db");
    await seed(db, [
      { test_id: "t5", status: "passed", day: 0 },
      { test_id: "t5", status: "passed", day: 1 },
      { test_id: "t5", status: "passed", day: 2 },
      { test_id: "t5", status: "failed", day: 3 }, // no sha/branch/author
    ]);

    const result = await correlateGitCommitFlakiness(db, { minStableRuns: 3 });
    expect(result).toHaveLength(1);
    expect(result[0].git_commit_sha).toBeNull();
    expect(result[0].git_branch).toBeNull();
    expect(result[0].git_author).toBeNull();
  });

  it("respects since_days filter", async () => {
    const db = join(testDir, "since-days.db");
    // Transition happened 40 days ago — outside the 30-day window
    const oldDay = Math.floor((Date.now() - 40 * DAY - BASE_TS) / DAY);
    await seed(db, [
      { test_id: "t6", status: "passed", day: oldDay },
      { test_id: "t6", status: "passed", day: oldDay + 1 },
      { test_id: "t6", status: "passed", day: oldDay + 2 },
      { test_id: "t6", status: "failed", day: oldDay + 3, sha: "old-sha" },
    ]);

    const result = await correlateGitCommitFlakiness(db, {
      minStableRuns: 3,
      since: Date.now() - 30 * DAY,
    });
    expect(result).toHaveLength(0);
  });

  it("returns both transition types for a test that recovered", async () => {
    const db = join(testDir, "both-transitions.db");
    await seed(db, [
      { test_id: "t7", status: "passed", day: 0 },
      { test_id: "t7", status: "passed", day: 1 },
      { test_id: "t7", status: "passed", day: 2 },
      { test_id: "t7", status: "failed", day: 3, sha: "broke" }, // stable→flaky
      { test_id: "t7", status: "failed", day: 4 },
      { test_id: "t7", status: "passed", day: 5 }, // starts recovering
      { test_id: "t7", status: "passed", day: 6 },
      { test_id: "t7", status: "passed", day: 7 }, // flaky→stable after 3 passes
    ]);

    const result = await correlateGitCommitFlakiness(db, { minStableRuns: 3 });
    const types = result.map((r) => r.transition_type);
    expect(types).toContain("stable_to_flaky");
    expect(types).toContain("flaky_to_stable");
  });
});
