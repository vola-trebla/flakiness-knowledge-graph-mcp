#!/usr/bin/env node
/**
 * Populates a demo flakiness.db with 30 days of realistic test run history.
 *
 * Run: npm run seed
 * Output: ./flakiness.db (or pass a path as first arg)
 *
 * Designed to demonstrate all 6 MCP tools:
 *   - get_flaky_tests        — mix of stable and unreliable tests
 *   - get_test_history       — per-run detail for each test
 *   - get_flakiness_trend    — one test that worsens over time
 *   - get_failure_patterns   — failures concentrated on webkit/linux
 *   - get_error_groups       — multiple tests sharing the same error
 *   - get_slow_tests         — one test with consistently high duration
 */

import { insertRun } from './db.js';

const DB_PATH = process.argv[2] ?? 'flakiness.db';
const NOW = Date.now();
const DAY = 86_400_000;

function daysAgo(n: number): number {
  return NOW - n * DAY;
}

function jitter(base: number, pct = 0.2): number {
  return Math.round(base * (1 + (Math.random() - 0.5) * pct));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

interface RunSpec {
  test_id: string;
  title: string;
  suite: string;
  status: 'passed' | 'failed' | 'flaky' | 'skipped';
  duration_ms: number;
  browser: string;
  os: string;
  timestamp: number;
  error?: string;
  retry: number;
}

const runs: RunSpec[] = [];

// --- 1. Stable test (login) — 1-2 runs/day, 95% pass ---
for (let d = 30; d >= 0; d--) {
  const count = pick([1, 2]);
  for (let i = 0; i < count; i++) {
    const pass = Math.random() > 0.05;
    runs.push({
      test_id: 'test-login-001',
      title: 'User can log in',
      suite: 'Auth',
      status: pass ? 'passed' : 'failed',
      duration_ms: jitter(1200),
      browser: 'chromium',
      os: 'linux',
      timestamp: daysAgo(d) + i * 3600_000,
      error: pass ? undefined : 'Error: Expected element to be visible',
      retry: 0,
    });
  }
}

// --- 2. Moderately flaky checkout — 25% failure rate ---
for (let d = 30; d >= 0; d--) {
  const pass = Math.random() > 0.25;
  const retry = !pass && Math.random() > 0.5 ? 1 : 0;
  runs.push({
    test_id: 'test-checkout-002',
    title: 'Checkout flow completes',
    suite: 'E-Commerce',
    status: pass ? 'passed' : retry > 0 ? 'flaky' : 'failed',
    duration_ms: jitter(4500),
    browser: pick(['chromium', 'firefox']),
    os: 'linux',
    timestamp: daysAgo(d),
    error: pass
      ? undefined
      : "Error: Timeout 30000ms exceeded waiting for locator('.payment-success')",
    retry,
  });
}

// --- 3. Trending worse cart test — 5% failure days 30-11, climbing to 70% in last 10 days ---
for (let d = 30; d >= 0; d--) {
  const failRate = d > 10 ? 0.05 : 0.07 * (11 - d); // 0.07 → 0.70 over 10 days
  const pass = Math.random() > failRate;
  runs.push({
    test_id: 'test-cart-003',
    title: 'Add item to cart',
    suite: 'E-Commerce',
    status: pass ? 'passed' : 'failed',
    duration_ms: jitter(2200),
    browser: 'chromium',
    os: 'linux',
    timestamp: daysAgo(d),
    error: pass ? undefined : "Error: locator('.add-to-cart') is not attached to the DOM",
    retry: 0,
  });
}

// --- 4. Browser-specific modal — only fails on webkit ---
const browsers = ['chromium', 'firefox', 'webkit'] as const;
for (let d = 30; d >= 0; d--) {
  for (const browser of browsers) {
    const pass = browser !== 'webkit' || Math.random() > 0.8;
    runs.push({
      test_id: 'test-modal-004',
      title: 'Modal dialog closes on Escape',
      suite: 'UI',
      status: pass ? 'passed' : 'failed',
      duration_ms: jitter(800),
      browser,
      os: 'linux',
      timestamp: daysAgo(d),
      error: pass ? undefined : 'Error: Expected modal to be hidden, but it is still visible',
      retry: 0,
    });
  }
}

// --- 5. Slow PDF report test ---
for (let d = 30; d >= 0; d--) {
  runs.push({
    test_id: 'test-report-005',
    title: 'Generate PDF report',
    suite: 'Reports',
    status: 'passed',
    duration_ms: jitter(18000, 0.3),
    browser: 'chromium',
    os: 'linux',
    timestamp: daysAgo(d),
    retry: 0,
  });
}

// --- 6-8. Error group — three API tests all hit the same backend timeout ---
const apiTests = [
  { id: 'test-api-006', title: 'Fetch user profile', suite: 'API' },
  { id: 'test-api-007', title: 'Fetch order history', suite: 'API' },
  { id: 'test-api-008', title: 'Submit contact form', suite: 'API' },
];

const sharedError =
  'Error: connect ECONNREFUSED 127.0.0.1:3001\n    at TCPConnectWrap.afterConnect';

for (let d = 30; d >= 0; d--) {
  // Cluster failures on specific days (simulates backend outages)
  const outageDay = d === 5 || d === 12 || d === 19;
  for (const t of apiTests) {
    const pass = !outageDay || Math.random() > 0.1;
    runs.push({
      test_id: t.id,
      title: t.title,
      suite: t.suite,
      status: pass ? 'passed' : 'failed',
      duration_ms: jitter(950),
      browser: 'chromium',
      os: 'linux',
      timestamp: daysAgo(d),
      error: pass ? undefined : sharedError,
      retry: 0,
    });
  }
}

// --- 9. Stable signup test ---
for (let d = 30; d >= 0; d--) {
  runs.push({
    test_id: 'test-signup-009',
    title: 'User can sign up',
    suite: 'Auth',
    status: 'passed',
    duration_ms: jitter(1800),
    browser: 'chromium',
    os: 'linux',
    timestamp: daysAgo(d),
    retry: 0,
  });
}

// --- Insert all runs ---
console.log(`Seeding ${runs.length} runs into ${DB_PATH}...`);

for (const run of runs) {
  await insertRun(DB_PATH, {
    ...run,
    file: `tests/${run.suite.toLowerCase()}/${run.test_id}.spec.ts`,
  });
}

console.log(`Done. Open ${DB_PATH} with your MCP client to explore the data.`);
console.log(`\nTry asking your AI:`);
console.log(`  "Which tests are most flaky? DB is at ${DB_PATH}"`);
console.log(`  "Show the flakiness trend for test-cart-003 over 30 days"`);
console.log(`  "Are there error groups with shared root causes?"`);
