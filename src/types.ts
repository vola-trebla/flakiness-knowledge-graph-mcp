export interface TestRun {
  id: number;
  test_id: string;
  title: string;
  suite: string;
  file: string;
  status: "passed" | "failed" | "flaky" | "skipped";
  duration_ms: number;
  browser: string;
  os: string;
  timestamp: number;
  error?: string;
  retry: number;
}

export interface FlakinessStats {
  test_id: string;
  title: string;
  suite: string;
  file: string;
  total_runs: number;
  passed: number;
  failed: number;
  flaky: number;
  flakiness_rate: number;
  avg_duration_ms: number;
  last_seen: number;
}

export interface ErrorGroup {
  error_signature: string;
  affected_tests: number;
  total_failures: number;
  test_ids: string;
  titles: string;
  last_seen: number;
}

export interface TrendBucket {
  day: string;
  total_runs: number;
  failures: number;
  flakiness_rate: number;
}

export interface DbConfig {
  dbPath: string;
}
