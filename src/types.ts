export interface TestRun {
  id: number;
  test_id: string;
  title: string;
  suite: string;
  file: string;
  status: 'passed' | 'failed' | 'flaky' | 'skipped';
  duration_ms: number;
  browser: string;
  os: string;
  timestamp: number;
  error?: string;
  retry: number;
  git_commit_sha?: string | null;
  git_branch?: string | null;
  git_author?: string | null;
}

export interface GitFlakinessTransition {
  test_id: string;
  title: string;
  transition_type: 'stable_to_flaky' | 'flaky_to_stable';
  git_commit_sha: string | null;
  git_branch: string | null;
  git_author: string | null;
  transition_date: string;
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
