#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { getFlakyTests, getTestHistory, getFailurePatterns, getSlowTests } from "./db.js";

const server = new McpServer({
  name: "flakiness-knowledge-graph",
  version: "0.1.0",
});

const dbInputSchema = z.object({
  db_path: z.string().describe("Absolute path to the flakiness.db SQLite file"),
});

function errorResponse(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` },
    ],
    isError: true,
  };
}

server.registerTool(
  "get_flaky_tests",
  {
    description:
      "Returns tests ranked by flakiness rate (failed+flaky / total runs). " +
      "Use to answer: which tests are the most unreliable?",
    inputSchema: dbInputSchema.extend({
      min_runs: z
        .number()
        .int()
        .min(1)
        .default(3)
        .describe("Minimum number of runs to consider a test (filters out one-off failures)"),
      limit: z.number().int().min(1).max(100).default(20).describe("Max tests to return"),
      since_days: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Only include runs from the last N days"),
    }),
  },
  async ({ db_path, min_runs, limit, since_days }) => {
    try {
      const since = since_days ? Date.now() - since_days * 86_400_000 : undefined;
      const tests = await getFlakyTests(db_path, { minRuns: min_runs, limit, since });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ total: tests.length, flaky_tests: tests }, null, 2),
          },
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  "get_test_history",
  {
    description:
      "Returns the run history for a specific test — status, duration, error, retry count, " +
      "browser, and OS for each run. Use to answer: is this test getting worse over time?",
    inputSchema: dbInputSchema.extend({
      test_id: z.string().describe("Test ID from get_flaky_tests"),
      limit: z.number().int().min(1).max(200).default(50).describe("Max runs to return"),
    }),
  },
  async ({ db_path, test_id, limit }) => {
    try {
      const history = await getTestHistory(db_path, test_id, limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ test_id, total: history.length, runs: history }, null, 2),
          },
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  "get_failure_patterns",
  {
    description:
      "Breaks down failure rates by browser and OS combination. " +
      "Use to answer: does this test only fail on Firefox? Only on Windows?",
    inputSchema: dbInputSchema.extend({
      since_days: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Only include runs from the last N days"),
    }),
  },
  async ({ db_path, since_days }) => {
    try {
      const since = since_days ? Date.now() - since_days * 86_400_000 : undefined;
      const patterns = await getFailurePatterns(db_path, { since });
      return {
        content: [{ type: "text", text: JSON.stringify({ patterns }, null, 2) }],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

server.registerTool(
  "get_slow_tests",
  {
    description:
      "Returns tests ranked by average duration. " +
      "Use to answer: which tests are slowing down the CI pipeline?",
    inputSchema: dbInputSchema.extend({
      limit: z.number().int().min(1).max(100).default(20).describe("Max tests to return"),
    }),
  },
  async ({ db_path, limit }) => {
    try {
      const tests = await getSlowTests(db_path, limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ total: tests.length, slow_tests: tests }, null, 2),
          },
        ],
      };
    } catch (err) {
      return errorResponse(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
