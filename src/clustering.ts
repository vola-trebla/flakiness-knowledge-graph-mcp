export interface SemanticCluster {
  cluster_id: string;
  canonical_message: string;
  normalized_message: string;
  instance_count: number;
  affected_tests: number;
  error_taxonomy:
    | "TimeoutError"
    | "AssertionError"
    | "NetworkError"
    | "ReferenceError"
    | "UnknownError";
  sample_test_ids: string[];
  last_seen: number;
}

// Order matters: longer/more specific patterns before shorter ones
const NORMALIZERS: Array<[RegExp, string]> = [
  [/https?:\/\/[^\s"')]+/g, "<url>"],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>"],
  [/0x[0-9a-f]{4,}/gi, "<hex>"],
  [/[0-9a-f]{32,}/gi, "<hash>"],
  [/\b\d{10,13}\b/g, "<ts>"],
  [/\b\d+\b/g, "<num>"],
  [/\s+/g, " "],
];

export function normalizeError(msg: string): string {
  let s = msg.trim();
  for (const [pattern, replacement] of NORMALIZERS) {
    s = s.replace(pattern, replacement);
  }
  return s.trim();
}

export function classifyError(msg: string): SemanticCluster["error_taxonomy"] {
  if (/timeout/i.test(msg)) return "TimeoutError";
  if (/expect|assert|toEqual|toBe|toHave|Expected/i.test(msg)) return "AssertionError";
  if (/net::|ERR_|ECONNREFUSED|Failed to fetch|ETIMEDOUT|ENOTFOUND/i.test(msg))
    return "NetworkError";
  if (/ReferenceError|TypeError|is not defined|Cannot read/i.test(msg)) return "ReferenceError";
  return "UnknownError";
}

// Levenshtein distance capped at 100 chars per string
function levenshtein(a: string, b: string): number {
  const A = a.slice(0, 100);
  const B = b.slice(0, 100);
  const m = A.length;
  const n = B.length;
  const prev = Array.from({ length: n + 1 }, (_, j) => j);
  const curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] =
        A[i - 1] === B[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev.splice(0, n + 1, ...curr);
  }
  return prev[n];
}

function areSimilar(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return true;
  const dist = levenshtein(a, b);
  return dist / maxLen <= 0.15;
}

const MAX_GROUPS_FOR_LEVENSHTEIN = 100;

export function clusterErrors(
  failures: Array<{ error: string; test_id: string; timestamp: number }>
): SemanticCluster[] {
  type Item = {
    error: string;
    test_id: string;
    timestamp: number;
    normalized: string;
    taxonomy: SemanticCluster["error_taxonomy"];
  };

  const items: Item[] = failures.map((f) => ({
    ...f,
    normalized: normalizeError(f.error),
    taxonomy: classifyError(f.error),
  }));

  // Group by exact normalized key
  const exactGroups = new Map<string, Item[]>();
  for (const item of items) {
    const group = exactGroups.get(item.normalized);
    if (group) group.push(item);
    else exactGroups.set(item.normalized, [item]);
  }

  // Merge similar groups via Levenshtein when feasible
  const groups = [...exactGroups.entries()].map(([norm, its]) => ({ norm, items: its }));
  const merged = new Array<boolean>(groups.length).fill(false);
  const finalGroups: Array<{ norm: string; items: Item[] }> = [];

  if (groups.length <= MAX_GROUPS_FOR_LEVENSHTEIN) {
    for (let i = 0; i < groups.length; i++) {
      if (merged[i]) continue;
      let combined = groups[i].items;
      for (let j = i + 1; j < groups.length; j++) {
        if (merged[j]) continue;
        if (areSimilar(groups[i].norm, groups[j].norm)) {
          combined = combined.concat(groups[j].items);
          merged[j] = true;
        }
      }
      finalGroups.push({ norm: groups[i].norm, items: combined });
    }
  } else {
    for (let i = 0; i < groups.length; i++) {
      finalGroups.push(groups[i]);
    }
  }

  return finalGroups
    .sort((a, b) => b.items.length - a.items.length)
    .map((g, idx) => {
      const testIds = [...new Set(g.items.map((i) => i.test_id))];
      return {
        cluster_id: `cluster-${idx + 1}`,
        canonical_message: g.items[0].error.slice(0, 300),
        normalized_message: g.norm.slice(0, 200),
        instance_count: g.items.length,
        affected_tests: testIds.length,
        error_taxonomy: g.items[0].taxonomy,
        sample_test_ids: testIds.slice(0, 5),
        last_seen: Math.max(...g.items.map((i) => i.timestamp)),
      };
    });
}
