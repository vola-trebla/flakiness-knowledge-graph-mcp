import type {
  Reporter,
  TestCase,
  TestResult,
  FullConfig,
  Suite,
  FullResult,
} from "@playwright/test/reporter";
import { insertRun } from "./db.js";

export interface FlakinessReporterOptions {
  dbPath?: string;
}

class FlakinessReporter implements Reporter {
  private dbPath: string;
  private os: string = process.platform;

  constructor(options: FlakinessReporterOptions = {}) {
    this.dbPath = options.dbPath ?? "flakiness.db";
  }

  onBegin(_config: FullConfig, _suite: Suite): void {}

  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    const outcome = test.outcome();
    const status =
      outcome === "skipped"
        ? "skipped"
        : outcome === "flaky"
          ? "flaky"
          : result.status === "passed"
            ? "passed"
            : "failed";

    // Resolve the actual browser from the test's own project, not config.projects[0]
    const browser = test.parent.project()?.use?.browserName ?? "chromium";

    const error = result.errors[0]?.message ?? result.errors[0]?.value ?? undefined;

    await insertRun(this.dbPath, {
      test_id: test.id,
      title: test.title,
      suite: test.parent?.title ?? "",
      file: test.location.file,
      status,
      duration_ms: result.duration,
      browser,
      os: this.os,
      timestamp: Date.now(),
      error: error ? String(error).slice(0, 1000) : undefined,
      retry: result.retry,
    });
  }

  onEnd(_result: FullResult): void {}
}

export default FlakinessReporter;
