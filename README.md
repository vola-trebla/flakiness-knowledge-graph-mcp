# 📊 flakiness-knowledge-graph-mcp

A Playwright custom reporter + MCP server that builds a local flakiness knowledge graph from your test run history. Ask your AI agent which tests are unreliable, on which browser, and whether they're getting worse.

## 🤔 The Problem

A single Playwright trace tells you _what_ failed right now. It doesn't tell you whether this test has been silently flaking for two weeks, or only fails on Firefox in CI, or is getting slower with every release.

This tool fixes that by accumulating run history into a SQLite database and exposing it to AI agents via MCP.

## 🛠️ Tools

| Tool                   | Arguments                                           | What it returns                                                                    |
| ---------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `get_flaky_tests`      | `db_path`, `min_runs?`, `limit?`, `since_days?`     | Tests ranked by flakiness rate (failed+flaky / total runs)                         |
| `get_test_history`     | `db_path`, `test_id`, `limit?`                      | Full run history for a specific test — status, duration, error, retry, browser, OS |
| `get_failure_patterns` | `db_path`, `since_days?`                            | Failure rates broken down by browser × OS combination                              |
| `get_slow_tests`       | `db_path`, `limit?`                                 | Tests ranked by average duration                                                   |
| `get_error_groups`     | `db_path`, `min_failures?`, `limit?`, `since_days?` | Failures clustered by error message — surfaces shared root causes across tests     |
| `get_flakiness_trend`  | `db_path`, `test_id`, `days?`                       | Daily flakiness rate over the last N days — shows whether a test is getting worse  |

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

Then point your AI agent at `./demo.db` to explore all 6 tools.

## 💬 Example usage

```
I've been running my Playwright suite for two weeks. The DB is at /my-project/flakiness.db.

1. get_flaky_tests — which tests are most unreliable? Show last 7 days only.
2. get_test_history for the top flaky test — is it getting worse?
3. get_flakiness_trend for the same test over 14 days — plot the daily rate.
4. get_failure_patterns — does it only fail on a specific browser or OS?
5. get_error_groups — are multiple tests failing with the same error? That's a backend issue.
6. get_slow_tests — which tests should I optimize for CI speed?
```

## 🔗 Works great with playwright-trace-decoder-mcp

These two MCP servers are designed to complement each other:

- **flakiness-knowledge-graph-mcp** answers "is this test flaky historically?"
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
        timestamp, error, retry

MCP server
  └── reads flakiness.db on demand (in-process handle reuse)
```

`sql.js` is used instead of `better-sqlite3` — pure JavaScript SQLite compiled to WebAssembly, no native compilation needed.

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
