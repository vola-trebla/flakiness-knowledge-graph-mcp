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
  private browser: string = "chromium";
  private os: string = process.platform;

  constructor(options: FlakinessReporterOptions = {}) {
    this.dbPath = options.dbPath ?? "flakiness.db";
  }

  onBegin(config: FullConfig, _suite: Suite): void {
    const project = config.projects[0];
    if (project?.use?.browserName) {
      this.browser = project.use.browserName;
    }
  }

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

    const error = result.errors[0]?.message ?? result.errors[0]?.value ?? undefined;

    await insertRun(this.dbPath, {
      test_id: test.id,
      title: test.title,
      suite: test.parent?.title ?? "",
      file: test.location.file,
      status,
      duration_ms: result.duration,
      browser: this.browser,
      os: this.os,
      timestamp: Date.now(),
      error: error ? String(error).slice(0, 500) : undefined,
      retry: result.retry,
    });
  }

  onEnd(_result: FullResult): void {}
}

export default FlakinessReporter;
