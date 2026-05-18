# 📊 flakiness-knowledge-graph-mcp

[![npm version](https://img.shields.io/npm/v/flakiness-knowledge-graph-mcp.svg)](https://www.npmjs.com/package/flakiness-knowledge-graph-mcp)
[![npm downloads](https://img.shields.io/npm/dm/flakiness-knowledge-graph-mcp.svg)](https://www.npmjs.com/package/flakiness-knowledge-graph-mcp)
[![CI](https://github.com/vola-trebla/flakiness-knowledge-graph-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/vola-trebla/flakiness-knowledge-graph-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A Playwright custom reporter + MCP server that builds a local flakiness knowledge graph from your test run history. Ask your AI agent which tests are unreliable, on which browser, and whether they're getting worse.

## 🤔 The Problem

A single Playwright trace tells you _what_ failed right now. It doesn't tell you whether this test has been silently flaking for two weeks, or only fails on Firefox in CI, or is getting slower with every release.

This tool fixes that by accumulating run history into a SQLite database and exposing it to AI agents via MCP.

## 🛠️ Tools

| Tool                             | Arguments                                           | What it returns                                                                                                    |
| -------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `get_flaky_tests`                | `db_path`, `min_runs?`, `limit?`, `since_days?`     | Tests ranked by flakiness rate (failed+flaky / total runs)                                                         |
| `get_test_history`               | `db_path`, `test_id`, `limit?`                      | Full run history for a specific test — status, duration, error, retry, browser, OS                                 |
| `get_failure_patterns`           | `db_path`, `since_days?`                            | Failure rates broken down by browser × OS combination                                                              |
| `get_slow_tests`                 | `db_path`, `limit?`                                 | Tests ranked by average duration                                                                                   |
| `get_error_groups`               | `db_path`, `min_failures?`, `limit?`, `since_days?` | Failures clustered by exact error prefix — surfaces shared root causes across tests                                |
| `get_flakiness_trend`            | `db_path`, `test_id`, `days?`                       | Daily flakiness rate over the last N days — shows whether a test is getting worse                                  |
| `cluster_semantic_error_trees`   | `db_path`, `min_instances?`, `since_days?`          | Like `get_error_groups` but normalises dynamic values (UUIDs, IDs, URLs) first, then fuzzy-merges with Levenshtein |
| `correlate_git_commit_flakiness` | `db_path`, `min_stable_runs?`, `since_days?`        | Finds the exact commit SHA where a test transitioned stable→flaky (or back), with branch and author                |

## 🚀 Setup

### 1. Install

```bash
npm install -g flakiness-knowledge-graph-mcp
```

Or build from source:

```bash
git clone https://github.com/vola-trebla/flakiness-knowledge-graph-mcp.git
cd flakiness-knowledge-graph-mcp
npm install && npm run build
```

### 2. Add the reporter to your Playwright project

```ts
// playwright.config.ts
export default defineConfig({
  reporter: [["html"], ["flakiness-knowledge-graph-mcp/reporter", { dbPath: "./flakiness.db" }]],
});
```

Run your tests normally — the reporter writes every result to `flakiness.db` automatically.

### 3. Add the MCP server to your editor

#### Cursor / VS Code (`.cursor/mcp.json` or `.vscode/mcp.json`)

```json
{
  "mcpServers": {
    "flakiness-knowledge-graph": {
      "command": "flakiness-knowledge-graph-mcp"
    }
  }
}
```

#### Claude Code

```bash
claude mcp add flakiness-knowledge-graph flakiness-knowledge-graph-mcp
```

### 4. Try it with demo data

No Playwright project yet? Generate 30 days of realistic sample data:

```bash
npx flakiness-graph-seed ./demo.db
```

Then point your AI agent at `./demo.db` to explore all 8 tools.

## 💬 Example usage

```
I've been running my Playwright suite for two weeks. The DB is at /my-project/flakiness.db.

1. get_flaky_tests — which tests are most unreliable? Show last 7 days only.
2. get_test_history for the top flaky test — is it getting worse?
3. get_flakiness_trend for the same test over 14 days — plot the daily rate.
4. get_failure_patterns — does it only fail on a specific browser or OS?
5. cluster_semantic_error_trees — are multiple tests failing with semantically identical errors?
6. correlate_git_commit_flakiness — which commit introduced the flakiness?
7. get_slow_tests — which tests should I optimize for CI speed?
```

### Grouping errors that look different but aren't

`get_error_groups` clusters by raw string prefix — if the error contains a UUID or element ID it creates separate groups for what is really one root cause. `cluster_semantic_error_trees` strips dynamic values first:

```json
{
  "total_clusters": 2,
  "clusters": [
    {
      "cluster_id": "cluster-1",
      "canonical_message": "TimeoutError: locator.click: Timeout 30000ms exceeded\n  waiting for locator('#submit-btn')",
      "normalized_message": "TimeoutError: locator.click: Timeout <num>ms exceeded waiting for locator",
      "error_taxonomy": "TimeoutError",
      "instance_count": 14,
      "affected_tests": 3,
      "sample_test_ids": ["checkout > submit order", "cart > add item", "checkout > apply coupon"]
    },
    {
      "cluster_id": "cluster-2",
      "canonical_message": "Error: 2 requests to https://api.example.com/orders/8f3a1c were made. Expected 1",
      "normalized_message": "Error: <num> requests to <url> were made. Expected <num>",
      "error_taxonomy": "AssertionError",
      "instance_count": 6,
      "affected_tests": 1,
      "sample_test_ids": ["api-mock > intercept order"]
    }
  ]
}
```

### Finding the commit that broke a test

`correlate_git_commit_flakiness` uses a state machine — it looks for runs where a test was stable for ≥3 consecutive passes, then failed. The transition record includes the SHA from the CI environment:

```json
{
  "total_transitions": 1,
  "transitions": [
    {
      "test_id": "auth > login > should redirect after login",
      "title": "should redirect after login",
      "transition_type": "stable_to_flaky",
      "git_commit_sha": "a3f8c1d9e2b54f6a",
      "git_branch": "main",
      "git_author": "dev-handle",
      "transition_date": "2025-04-14"
    }
  ]
}
```

The reporter reads `GITHUB_SHA` / `CI_COMMIT_SHA` / `CIRCLE_SHA1` / `GIT_COMMIT` automatically — no reporter config changes needed beyond upgrading to v0.2.0.

## 🔗 Works great with playwright-trace-decoder-mcp

These two MCP servers are designed to complement each other:

- **flakiness-knowledge-graph-mcp** answers "is this test flaky historically, and which commit caused it?"
- **[playwright-trace-decoder-mcp](https://github.com/vola-trebla/playwright-trace-decoder-mcp)** answers "what exactly failed in this specific run?"

Combined, an AI agent can diagnose whether a CI failure is a known flaky test or a new regression — without you opening a single file.

## 🏗️ Architecture

```
playwright.config.ts
  └── FlakinessReporter → flakiness.db (SQLite via sql.js)

flakiness.db
  └── test_runs table
        id, test_id, title, suite, file,
        status, duration_ms, browser, os,
        timestamp, error, retry,
        git_commit_sha, git_branch, git_author   ← added in v0.2.0

MCP server
  └── reads flakiness.db on demand (in-process handle reuse)
```

`sql.js` is used instead of `better-sqlite3` — pure JavaScript SQLite compiled to WebAssembly, no native compilation needed. The git columns are added via `ALTER TABLE` migration on first use — existing databases upgrade automatically.

## 📋 Scripts

```bash
npm run build        # compile TypeScript → dist/
npm run lint         # ESLint
npm run format       # Prettier --write
npm run format:check # Prettier check (used in CI)
npm run seed         # populate flakiness.db with 30 days of demo data
```

## 📄 License

MIT
