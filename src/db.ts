import { readFileSync, existsSync, writeFileSync } from 'fs';
import initSqlJs, { Database } from 'sql.js';
import {
  TestRun,
  FlakinessStats,
  ErrorGroup,
  TrendBucket,
  GitFlakinessTransition,
} from './types.js';

// Per-path DB handles so multiple projects don't share state
const dbCache = new Map<string, Database>();

// Per-path write queues to serialise concurrent worker writes
const writeQueues = new Map<string, Promise<void>>();

async function getDb(path: string): Promise<Database> {
  const cached = dbCache.get(path);
  if (cached) return cached;
  const SQL = await initSqlJs();
  const db = existsSync(path) ? new SQL.Database(readFileSync(path)) : new SQL.Database();
  applySchema(db);
  dbCache.set(path, db);
  return db;
}

function persist(database: Database, path: string): void {
  writeFileSync(path, Buffer.from(database.export()));
}

function applySchema(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS test_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id TEXT NOT NULL,
      title TEXT NOT NULL,
      suite TEXT NOT NULL,
      file TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      browser TEXT NOT NULL DEFAULT 'chromium',
      os TEXT NOT NULL DEFAULT 'unknown',
      timestamp INTEGER NOT NULL,
      error TEXT,
      retry INTEGER NOT NULL DEFAULT 0,
      git_commit_sha TEXT,
      git_branch TEXT,
      git_author TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_test_id ON test_runs(test_id);
    CREATE INDEX IF NOT EXISTS idx_timestamp ON test_runs(timestamp);
  `);
  // Migration for existing tables that predate git columns
  for (const col of ['git_commit_sha TEXT', 'git_branch TEXT', 'git_author TEXT']) {
    try {
      database.run(`ALTER TABLE test_runs ADD COLUMN ${col}`);
    } catch {
      // column already exists — ignore
    }
  }
}

// Serialise all writes through a per-path promise chain so parallel
// Playwright workers never race to overwrite the same file.
export async function insertRun(path: string, run: Omit<TestRun, 'id'>): Promise<void> {
  const prev = writeQueues.get(path) ?? Promise.resolve();
  const next = prev.then(async () => {
    // Re-read from disk each time so we don't miss writes from other workers
    const SQL = await initSqlJs();
    const db = existsSync(path) ? new SQL.Database(readFileSync(path)) : new SQL.Database();
    applySchema(db);
    dbCache.set(path, db);

    db.run(
      `INSERT INTO test_runs
       (test_id, title, suite, file, status, duration_ms, browser, os, timestamp, error, retry,
        git_commit_sha, git_branch, git_author)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.test_id,
        run.title,
        run.suite,
        run.file,
        run.status,
        run.duration_ms,
        run.browser,
        run.os,
        run.timestamp,
        run.error ?? null,
        run.retry,
        run.git_commit_sha ?? null,
        run.git_branch ?? null,
        run.git_author ?? null,
      ]
    );
    persist(db, path);
  });
  writeQueues.set(path, next);
  await next;
}

export async function getFlakyTests(
  path: string,
  { minRuns = 3, limit = 20, since }: { minRuns?: number; limit?: number; since?: number } = {}
): Promise<FlakinessStats[]> {
  const database = await getDb(path);
  const sinceClause = since ? `AND timestamp >= ${since}` : '';
  const res = database.exec(`
    SELECT
      test_id,
      title,
      suite,
      file,
      COUNT(*) AS total_runs,
      SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS passed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'flaky'  THEN 1 ELSE 0 END) AS flaky,
      ROUND(CAST(SUM(CASE WHEN status IN ('failed','flaky') THEN 1 ELSE 0 END) AS REAL) / COUNT(*), 4) AS flakiness_rate,
      ROUND(AVG(duration_ms)) AS avg_duration_ms,
      MAX(timestamp) AS last_seen
    FROM test_runs
    WHERE 1=1 ${sinceClause}
    GROUP BY test_id
    HAVING total_runs >= ${minRuns} AND flakiness_rate > 0
    ORDER BY flakiness_rate DESC
    LIMIT ${limit}
  `);
  return rowsToObjects<FlakinessStats>(res);
}

export async function getTestHistory(path: string, testId: string, limit = 50): Promise<TestRun[]> {
  const database = await getDb(path);
  const res = database.exec(
    `SELECT * FROM test_runs WHERE test_id = ? ORDER BY timestamp DESC LIMIT ?`,
    [testId, limit]
  );
  return rowsToObjects<TestRun>(res);
}

export async function getFailurePatterns(
  path: string,
  { since }: { since?: number } = {}
): Promise<{ browser: string; os: string; failures: number; total: number; rate: number }[]> {
  const database = await getDb(path);
  const sinceClause = since ? `WHERE timestamp >= ${since}` : '';
  const res = database.exec(`
    SELECT
      browser,
      os,
      SUM(CASE WHEN status IN ('failed','flaky') THEN 1 ELSE 0 END) AS failures,
      COUNT(*) AS total,
      ROUND(CAST(SUM(CASE WHEN status IN ('failed','flaky') THEN 1 ELSE 0 END) AS REAL) / COUNT(*), 4) AS rate
    FROM test_runs ${sinceClause}
    GROUP BY browser, os
    ORDER BY rate DESC
  `);
  return rowsToObjects(res);
}

export async function getSlowTests(
  path: string,
  limit = 20
): Promise<{ test_id: string; title: string; avg_duration_ms: number; max_duration_ms: number }[]> {
  const database = await getDb(path);
  const res = database.exec(`
    SELECT
      test_id,
      title,
      ROUND(AVG(duration_ms)) AS avg_duration_ms,
      MAX(duration_ms) AS max_duration_ms
    FROM test_runs
    GROUP BY test_id
    ORDER BY avg_duration_ms DESC
    LIMIT ${limit}
  `);
  return rowsToObjects(res);
}

export async function getErrorGroups(
  path: string,
  {
    minFailures = 2,
    limit = 20,
    since,
  }: { minFailures?: number; limit?: number; since?: number } = {}
): Promise<ErrorGroup[]> {
  const database = await getDb(path);
  const sinceClause = since ? `AND timestamp >= ${since}` : '';
  const res = database.exec(`
    SELECT
      SUBSTR(TRIM(error), 1, 200) AS error_signature,
      COUNT(DISTINCT test_id) AS affected_tests,
      COUNT(*) AS total_failures,
      GROUP_CONCAT(DISTINCT test_id) AS test_ids,
      GROUP_CONCAT(DISTINCT title) AS titles,
      MAX(timestamp) AS last_seen
    FROM test_runs
    WHERE status IN ('failed', 'flaky') AND error IS NOT NULL ${sinceClause}
    GROUP BY error_signature
    HAVING total_failures >= ${minFailures}
    ORDER BY total_failures DESC
    LIMIT ${limit}
  `);
  return rowsToObjects<ErrorGroup>(res);
}

export async function getFlakinessTrend(
  path: string,
  testId: string,
  { days = 30 }: { days?: number } = {}
): Promise<TrendBucket[]> {
  const database = await getDb(path);
  const since = Date.now() - days * 86_400_000;
  const res = database.exec(
    `SELECT
      date(timestamp / 1000, 'unixepoch') AS day,
      COUNT(*) AS total_runs,
      SUM(CASE WHEN status IN ('failed', 'flaky') THEN 1 ELSE 0 END) AS failures,
      ROUND(CAST(SUM(CASE WHEN status IN ('failed', 'flaky') THEN 1 ELSE 0 END) AS REAL) / COUNT(*), 4) AS flakiness_rate
    FROM test_runs
    WHERE test_id = ? AND timestamp >= ?
    GROUP BY day
    ORDER BY day ASC`,
    [testId, since]
  );
  return rowsToObjects<TrendBucket>(res);
}

export async function getRawFailures(
  path: string,
  { limit = 1000, since }: { limit?: number; since?: number } = {}
): Promise<Array<{ error: string; test_id: string; timestamp: number }>> {
  const database = await getDb(path);
  const sinceClause = since ? `AND timestamp >= ${since}` : '';
  const res = database.exec(`
    SELECT error, test_id, timestamp
    FROM test_runs
    WHERE status IN ('failed', 'flaky') AND error IS NOT NULL ${sinceClause}
    ORDER BY timestamp DESC
    LIMIT ${limit}
  `);
  return rowsToObjects(res);
}

type RunRow = {
  test_id: string;
  title: string;
  status: string;
  timestamp: number;
  git_commit_sha: string | null;
  git_branch: string | null;
  git_author: string | null;
};

export async function correlateGitCommitFlakiness(
  path: string,
  { since, minStableRuns = 3 }: { since?: number; minStableRuns?: number } = {}
): Promise<GitFlakinessTransition[]> {
  const database = await getDb(path);
  const sinceClause = since ? `AND timestamp >= ${since}` : '';

  // Fetch runs for tests that have both passing and failing/flaky results
  const res = database.exec(`
    SELECT test_id, title, status, timestamp, git_commit_sha, git_branch, git_author
    FROM test_runs
    WHERE test_id IN (
      SELECT test_id FROM test_runs
      WHERE 1=1 ${sinceClause}
      GROUP BY test_id
      HAVING SUM(CASE WHEN status IN ('failed','flaky') THEN 1 ELSE 0 END) > 0
         AND SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) > 0
    ) ${sinceClause}
    ORDER BY test_id, timestamp ASC
  `);

  const allRows = rowsToObjects<RunRow>(res);

  // Group by test_id
  const byTest = new Map<string, RunRow[]>();
  for (const row of allRows) {
    const list = byTest.get(row.test_id);
    if (list) list.push(row);
    else byTest.set(row.test_id, [row]);
  }

  const results: GitFlakinessTransition[] = [];

  for (const [, runs] of byTest) {
    let consecutivePasses = 0;
    let lastFailRun: RunRow | null = null;
    type State = 'unknown' | 'stable' | 'flaky';
    let state: State = 'unknown';

    for (const run of runs) {
      const isBad = run.status === 'failed' || run.status === 'flaky';

      if (state === 'unknown' || state === 'stable') {
        if (!isBad) {
          consecutivePasses++;
          if (state === 'unknown') state = 'stable';
        } else {
          if (consecutivePasses >= minStableRuns) {
            results.push({
              test_id: run.test_id,
              title: runs[0].title,
              transition_type: 'stable_to_flaky',
              git_commit_sha: run.git_commit_sha,
              git_branch: run.git_branch,
              git_author: run.git_author,
              transition_date: new Date(run.timestamp).toISOString().slice(0, 10),
            });
          }
          consecutivePasses = 0;
          lastFailRun = run;
          state = 'flaky';
        }
      } else {
        // state === "flaky"
        if (isBad) {
          lastFailRun = run;
          consecutivePasses = 0;
        } else {
          consecutivePasses++;
          if (consecutivePasses >= minStableRuns && lastFailRun) {
            results.push({
              test_id: run.test_id,
              title: runs[0].title,
              transition_type: 'flaky_to_stable',
              git_commit_sha: lastFailRun.git_commit_sha,
              git_branch: lastFailRun.git_branch,
              git_author: lastFailRun.git_author,
              transition_date: new Date(lastFailRun.timestamp).toISOString().slice(0, 10),
            });
            lastFailRun = null;
            state = 'stable';
          }
        }
      }
    }
  }

  return results;
}

function rowsToObjects<T>(queryResult: ReturnType<Database['exec']>): T[] {
  if (!queryResult.length) return [];
  const { columns, values } = queryResult[0];
  return values.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj as T;
  });
}
