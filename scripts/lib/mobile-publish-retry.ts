/// <reference types="node" />

/**
 * Bounded retry support for self-hosted `eoas publish` calls.
 *
 * The EAS preview path deliberately does not import or call this helper. A
 * whole-command retry is safe only for the narrowly classified transient
 * failures below; every other non-zero exit remains a hard failure.
 */

import { spawn } from 'node:child_process';

/**
 * Backoff ladder for one platform, in wait order: 34 minutes total, sized to
 * outlast the object store's observed throttle cooldown (runs 29387706795 and
 * 30855435091 both stayed throttled ~17 minutes; the old 30/60/120s ladder gave
 * up ~8 minutes in and needed a manual re-run).
 *
 * Since eoas@3.1.2 this ladder is a BACKSTOP, not the primary defence: the CLI
 * now paces its own upload starts (`--upload-rate`, see scripts/lib/eoas.ts) and
 * retries 429/5xx with `Retry-After` internally, so a whole-command retry should
 * be rare. Leaving it long costs nothing on a healthy publish, which never
 * sleeps. Revisit only after a week of green publishes on 3.1.2 — and note that
 * shortening it means editing three workflows, since
 * scripts/mobile-ota-publish-workflow.test.ts derives their `timeout-minutes`
 * floors from these values. Rationale: docs/mobile-ota-updates.md.
 */
export const SELF_HOSTED_PUBLISH_RETRY_DELAYS_MS = [60_000, 180_000, 300_000, 600_000, 900_000] as const;
export const SELF_HOSTED_PUBLISH_MAX_ATTEMPTS = SELF_HOSTED_PUBLISH_RETRY_DELAYS_MS.length + 1;

/**
 * Measured cost of one throttled attempt (run 30855435091): a ~90s Metro export,
 * then uploads until the store rejects one. This is an observed floor, not a
 * ceiling — a bigger bundle or a slower runner pushes it up, which eats into the
 * headroom between a job's derived timeout floor and its actual `timeout-minutes`.
 * If publishes get materially slower, re-measure this before trusting the floor.
 */
export const SELF_HOSTED_PUBLISH_ATTEMPT_COST_MINUTES = 2.5;

/** Every wait plus the failed attempt that precedes each one. */
export const SELF_HOSTED_PUBLISH_WORST_CASE_MINUTES_PER_PLATFORM =
  SELF_HOSTED_PUBLISH_RETRY_DELAYS_MS.reduce((total, delayMs) => total + delayMs, 0) / 60_000 +
  SELF_HOSTED_PUBLISH_MAX_ATTEMPTS * SELF_HOSTED_PUBLISH_ATTEMPT_COST_MINUTES;

/**
 * Everything a publish job does around the publish steps themselves. Dominated
 * by the two source-map uploads, which carry their own `timeout-minutes` in the
 * workflow; the rest (checkout, setup-vp, `vp install`, changelog, health
 * check) measured ~3 minutes in run 30855435091. mobile-ota-publish-workflow.test.ts
 * re-reads those step timeouts and fails if they outgrow this allowance.
 */
export const SELF_HOSTED_PUBLISH_JOB_OVERHEAD_MINUTES = 30;

/**
 * Minimum `timeout-minutes` a publish job needs so a fully throttled run still
 * reaches the retry wrapper's own verdict instead of being killed mid-backoff.
 * `platforms` is how many platforms one job publishes sequentially: production
 * and preview do iOS then Android in a single job, backport fans out one
 * platform per matrix job.
 */
export function minimumPublishJobTimeoutMinutes(platforms: number): number {
  return (
    Math.ceil(platforms * SELF_HOSTED_PUBLISH_WORST_CASE_MINUTES_PER_PLATFORM) +
    SELF_HOSTED_PUBLISH_JOB_OVERHEAD_MINUTES
  );
}

export type OtaPublishPlatform = 'ios' | 'android';
export type PublishFailureKind = 's3-slowdown' | 'http-5xx' | 'permanent' | 'unknown';

export type TextOutput = {
  write(chunk: string): unknown;
};

export type PublishCommandRequest = {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
};

export type PublishCommandResult = {
  exitCode: number;
};

export type PublishCommandRunner = (request: PublishCommandRequest) => Promise<PublishCommandResult>;
export type PublishSleeper = (delayMs: number) => Promise<void>;

export type PublishRetryInvocation = {
  platform: OtaPublishPlatform;
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type PlatformPublishOutcome = {
  platform: OtaPublishPlatform;
  success: boolean;
  attempts: number;
  failureKind: PublishFailureKind | null;
  /**
   * The command exited 0 without creating an update, because xprem found the
   * bundle identical to one already in storage. See NO_CHANGE_NOTICE.
   */
  noChange: boolean;
};

/**
 * Asks the update server whether the branch is being offered for this platform
 * RIGHT NOW. Optional: a caller with no runtimeVersion to probe with (a local
 * publish) simply omits it and gets the unchanged ladder.
 */
export type PublishConfirmation = (platform: OtaPublishPlatform) => Promise<boolean>;

export type PublishRetryDependencies = {
  runner?: PublishCommandRunner;
  sleeper?: PublishSleeper;
  stdout?: TextOutput;
  stderr?: TextOutput;
  confirmPublished?: PublishConfirmation;
};

const CLASSIFIER_WINDOW_CHARS = 4096;

const EXPLICIT_HTTP_5XX =
  /(?:\bHTTP(?:\/\d(?:\.\d)?)?\s+|\b(?:status|statusCode|status code|response (?:status|code))\s*[:=]?\s*)5\d{2}\b/i;
const EXPLICIT_HTTP_4XX =
  /(?:\bHTTP(?:\/\d(?:\.\d)?)?\s+|\b(?:status|statusCode|status code|response (?:status|code))\s*[:=]?\s*)4\d{2}\b/i;
/**
 * The finalize call at the very end of a publish: every asset is already in the
 * object store, and this is the request that records the update against the
 * branch. It regularly outlives Cloudflare's 100 s origin cap on
 * updates.boardsesh.com, which answers 524 — so a 524 HERE says the proxy gave
 * up, NOT that the origin failed. Distinguished from any other 5xx because the
 * update may well have landed, which is worth confirming before spending a
 * ~2.5-minute re-export on it (see `confirmPublished` below).
 */
const FINALIZE_GATEWAY_TIMEOUT = /HTTP 524 from \S*\/markUpdateAsUploaded\//i;
/**
 * xprem skipping an export whose bundle is identical to one already in storage:
 *
 *   ⚠️ There is no change in the update for android, ignored...
 *   ⚠️ No changes found in the update, nothing to deploy
 *
 * eoas EXITS 0 on this, so without a scan for it the publisher reports
 * `android=success` for a platform it did not publish. Usually harmless — the
 * previous identical update is still on the branch — but not when the branch was
 * reset first, which is how #5417 lost its Android preview with nothing said. The
 * surfability check in mobile-publish.ts is what turns this into a hard failure;
 * this is only how the log learns to say what happened.
 */
const NO_CHANGE_NOTICE = /(?:no change in the update for (?:ios|android)|no changes found in the update)/i;
const S3_SLOWDOWN_CODE = /<Code>\s*SlowDown\s*<\/Code>/i;
const S3_SLOWDOWN_MESSAGE = /<Message>\s*Please reduce your request rate\.?\s*<\/Message>/i;
const PERMANENT_S3_CODE =
  /<Code>\s*(?:AccessDenied|AuthorizationHeaderMalformed|ExpiredToken|InvalidAccessKeyId|InvalidArgument|InvalidRequest|InvalidToken|NoSuchBucket|SignatureDoesNotMatch)\s*<\/Code>/i;
const PERMANENT_AUTH_ERROR =
  /\b(?:authentication failed|invalid (?:api[ -]?)?(?:key|token|credentials)|permission denied|unauthorized|forbidden)\b/i;
const PERMANENT_INPUT_ERROR =
  /\b(?:configuration error|invalid (?:argument|configuration|option|request)|missing required|validation error)\b/i;
const PERMANENT_BUILD_ERROR = /\b(?:expo export|bundle|build) failed\b|\b(?:ReferenceError|SyntaxError|TypeError):/i;

type FailureEvidence = {
  hasSlowDownCode: boolean;
  hasSlowDownMessage: boolean;
  hasHttp5xx: boolean;
  hasFinalizeTimeout: boolean;
  hasNoChangeNotice: boolean;
  hasPermanent: boolean;
};

function emptyEvidence(): FailureEvidence {
  return {
    hasSlowDownCode: false,
    hasSlowDownMessage: false,
    hasHttp5xx: false,
    hasFinalizeTimeout: false,
    hasNoChangeNotice: false,
    hasPermanent: false,
  };
}

/**
 * Incrementally classifies output while retaining only a small rolling window.
 * Evidence bits survive after text falls out of the window, so the helper never
 * needs a raw log tail to make or explain a retry decision.
 */
export class PublishFailureEvidenceScanner {
  private evidence = emptyEvidence();
  private window = '';

  push(chunk: string): void {
    const searchable = `${this.window}${chunk}`;
    this.evidence.hasSlowDownCode ||= S3_SLOWDOWN_CODE.test(searchable);
    this.evidence.hasSlowDownMessage ||= S3_SLOWDOWN_MESSAGE.test(searchable);
    this.evidence.hasHttp5xx ||= EXPLICIT_HTTP_5XX.test(searchable);
    this.evidence.hasFinalizeTimeout ||= FINALIZE_GATEWAY_TIMEOUT.test(searchable);
    this.evidence.hasNoChangeNotice ||= NO_CHANGE_NOTICE.test(searchable);
    this.evidence.hasPermanent ||=
      EXPLICIT_HTTP_4XX.test(searchable) ||
      PERMANENT_S3_CODE.test(searchable) ||
      PERMANENT_AUTH_ERROR.test(searchable) ||
      PERMANENT_INPUT_ERROR.test(searchable) ||
      PERMANENT_BUILD_ERROR.test(searchable);
    this.window = searchable.slice(-CLASSIFIER_WINDOW_CHARS);
  }

  /**
   * Whether this attempt died finalizing rather than uploading. A permanent
   * signal still vetoes it: a 524 that arrived alongside an auth failure is not
   * evidence the update landed.
   */
  sawFinalizeTimeout(): boolean {
    return this.evidence.hasFinalizeTimeout && !this.evidence.hasPermanent;
  }

  /** Whether xprem deduplicated this export instead of publishing it. */
  sawNoChangeNotice(): boolean {
    return this.evidence.hasNoChangeNotice;
  }

  classify(): PublishFailureKind {
    // Any permanent signal vetoes a retry, even when a retryable marker also
    // appeared earlier in the same command's mixed output.
    if (this.evidence.hasPermanent) return 'permanent';
    if (this.evidence.hasSlowDownCode && this.evidence.hasSlowDownMessage) return 's3-slowdown';
    if (this.evidence.hasHttp5xx) return 'http-5xx';
    return 'unknown';
  }
}

/** Convenience entry point for fixture/unit classification. */
export function classifyPublishFailure(output: string): PublishFailureKind {
  const scanner = new PublishFailureEvidenceScanner();
  scanner.push(output);
  return scanner.classify();
}

/**
 * Real child runner: stdout/stderr are piped so callers can both stream them
 * immediately and feed the evidence scanner. It never prints or summarizes an
 * error itself, which prevents a captured secret-bearing tail from being echoed
 * a second time.
 */
export const runStreamingPublishCommand: PublishCommandRunner = (request) =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode });
    };

    try {
      const child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        env: request.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', request.onStdout);
      child.stderr.on('data', request.onStderr);
      child.once('error', () => settle(1));
      child.once('close', (exitCode) => settle(exitCode ?? 1));
    } catch {
      settle(1);
    }
  });

export const sleepForPublishRetry: PublishSleeper = (delayMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

function platformLabel(platform: OtaPublishPlatform): string {
  return platform === 'ios' ? 'iOS' : 'Android';
}

function failureDescription(kind: PublishFailureKind): string {
  if (kind === 's3-slowdown') return 'S3 SlowDown';
  if (kind === 'http-5xx') return 'HTTP 5xx';
  if (kind === 'permanent') return 'permanent error evidence';
  return 'no retryable error evidence';
}

/**
 * Run one platform's self-hosted publish with four total attempts. Only exact
 * S3 SlowDown XML or an explicit HTTP 5xx is retryable. Output is streamed once
 * as it arrives; notices contain classification metadata only.
 */
export async function publishSelfHostedPlatformWithRetry(
  invocation: PublishRetryInvocation,
  dependencies: PublishRetryDependencies = {},
): Promise<PlatformPublishOutcome> {
  const runner = dependencies.runner ?? runStreamingPublishCommand;
  const sleeper = dependencies.sleeper ?? sleepForPublishRetry;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const confirmPublished = dependencies.confirmPublished;
  const label = platformLabel(invocation.platform);

  for (let attempt = 1; attempt <= SELF_HOSTED_PUBLISH_MAX_ATTEMPTS; attempt++) {
    const scanner = new PublishFailureEvidenceScanner();
    let exitCode = 1;
    try {
      const result = await runner({
        command: invocation.command,
        args: invocation.args,
        cwd: invocation.cwd,
        env: invocation.env,
        onStdout: (chunk) => {
          stdout.write(chunk);
          scanner.push(chunk);
        },
        onStderr: (chunk) => {
          stderr.write(chunk);
          scanner.push(chunk);
        },
      });
      exitCode = result.exitCode;
    } catch {
      // A runner failure has no retryable server evidence. Keep the diagnostic
      // intentionally generic: thrown errors can embed argv/env or a raw tail.
      stderr.write(`[mobile:publish] ${label} publish process failed to run; not retrying.\n`);
      return {
        platform: invocation.platform,
        success: false,
        attempts: attempt,
        failureKind: 'unknown',
        noChange: false,
      };
    }

    if (exitCode === 0) {
      return {
        platform: invocation.platform,
        success: true,
        attempts: attempt,
        failureKind: null,
        noChange: scanner.sawNoChangeNotice(),
      };
    }

    // A finalize 524 is Cloudflare hanging up on a slow origin, not a failed
    // upload — the update has usually landed. Ask the server before spending a
    // full re-export on it: #5422 burned 2h09m across six attempts that each
    // re-bundled ~5300 modules to reach the same timeout. Deliberately before
    // the retryable check, so it also rescues the LAST attempt.
    if (confirmPublished && scanner.sawFinalizeTimeout()) {
      stderr.write(
        `[mobile:publish] ${label} publish timed out finalizing (HTTP 524); asking the update server whether it landed.\n`,
      );
      let confirmed = false;
      try {
        confirmed = await confirmPublished(invocation.platform);
      } catch {
        // A probe failure is not evidence either way — fall through to the ladder.
        stderr.write(`[mobile:publish] ${label} could not reach the update server to confirm; retrying as usual.\n`);
      }
      if (confirmed) {
        stdout.write(
          `[mobile:publish] ${label} update is live on the branch despite the 524 — treating attempt ${attempt} as published.\n`,
        );
        return {
          platform: invocation.platform,
          success: true,
          attempts: attempt,
          failureKind: null,
          noChange: false,
        };
      }
    }

    const failureKind = scanner.classify();
    const retryable = failureKind === 's3-slowdown' || failureKind === 'http-5xx';
    if (!retryable || attempt === SELF_HOSTED_PUBLISH_MAX_ATTEMPTS) {
      const exhausted = retryable ? ' after exhausting the retry budget' : '';
      stderr.write(
        `[mobile:publish] ${label} publish failed (${failureDescription(failureKind)})${exhausted}; not retrying.\n`,
      );
      return { platform: invocation.platform, success: false, attempts: attempt, failureKind, noChange: false };
    }

    const delayMs = SELF_HOSTED_PUBLISH_RETRY_DELAYS_MS[attempt - 1];
    stderr.write(
      `[mobile:publish] ${label} publish attempt ${attempt}/${SELF_HOSTED_PUBLISH_MAX_ATTEMPTS} failed with ${failureDescription(failureKind)}; retrying in ${delayMs / 1000}s.\n`,
    );
    try {
      await sleeper(delayMs);
    } catch {
      stderr.write(`[mobile:publish] ${label} retry wait failed; not retrying.\n`);
      return { platform: invocation.platform, success: false, attempts: attempt, failureKind, noChange: false };
    }
  }

  // The loop always returns. Keep a defensive result so a future attempt-count
  // refactor cannot turn an empty loop into accidental success.
  return {
    platform: invocation.platform,
    success: false,
    attempts: SELF_HOSTED_PUBLISH_MAX_ATTEMPTS,
    failureKind: 'unknown',
    noChange: false,
  };
}

/** Run every requested platform in order, even after an earlier failure. */
export async function publishPlatformsSequentially(
  platforms: readonly OtaPublishPlatform[],
  publishPlatform: (platform: OtaPublishPlatform) => Promise<PlatformPublishOutcome>,
): Promise<PlatformPublishOutcome[]> {
  const outcomes: PlatformPublishOutcome[] = [];
  for (const platform of platforms) {
    try {
      outcomes.push(await publishPlatform(platform));
    } catch {
      outcomes.push({ platform, success: false, attempts: 0, failureKind: 'unknown', noChange: false });
    }
  }
  return outcomes;
}
