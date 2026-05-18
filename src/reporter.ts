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

function resolveGitContext(): {
  git_commit_sha: string | null;
  git_branch: string | null;
  git_author: string | null;
} {
  const e = process.env;
  return {
    git_commit_sha: e.GITHUB_SHA ?? e.CI_COMMIT_SHA ?? e.CIRCLE_SHA1 ?? e.GIT_COMMIT ?? null,
    git_branch:
      e.GITHUB_REF_NAME ?? e.CI_COMMIT_REF_NAME ?? e.CIRCLE_BRANCH ?? e.GIT_BRANCH ?? null,
    git_author: e.GITHUB_ACTOR ?? e.GITLAB_USER_NAME ?? e.CIRCLE_USERNAME ?? e.BUILD_USER ?? null,
  };
}

class FlakinessReporter implements Reporter {
  private dbPath: string;
  private os: string = process.platform;
  private gitContext = resolveGitContext();

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
      ...this.gitContext,
    });
  }

  onEnd(_result: FullResult): void {}
}

export default FlakinessReporter;
