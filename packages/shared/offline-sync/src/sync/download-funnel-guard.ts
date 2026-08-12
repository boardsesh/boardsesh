// The download funnel's terminal-event invariant (issue #4316).
//
// INVARIANT: every `Offline Board Download Started` is followed by exactly one
// terminal event for that attempt — `Offline Board Download Completed` when the
// scope finishes, `Offline Board Download Failed` otherwise.
//
// #4314 closed three specific bail-outs by hand (a sign-out, a wipe epoch bump,
// the app backgrounding), and a device still went silent: Started fired with an
// `artifactBytes` of 103 MB and no Completed, no Failed, and no Sentry event
// ever followed. Per-site reporting can only ever cover the sites somebody
// remembered, and `runBootstrapPhase` has a dozen ways out — `break`, `continue`,
// a `throw` from any of the ~15 awaited SQLite writes that sit OUTSIDE the
// import's try/catch, or a consumer callback (`onProgress`,
// `onBootstrapMetadataChanged`) throwing back into the loop.
//
// So the guard is structural instead. The phase arms it at the Started emission
// point and closes it from a `finally`; anything that reaches that `finally`
// without a recorded terminal event is reported as one. A future `break` added
// by someone who never reads this file is covered on the day it is written.
//
// WHAT COUNTS AS SETTLED
//  - any `onSnapshotBootstrapError` report for the armed scope (the Failed leg,
//    wired centrally so no report site has to remember to mark itself), and
//  - a successful import, which hands the funnel to the board-data loop's
//    Completed event.
//
// SEVERITY. Known teardowns keep #4314's convention: `aborted: true`,
// `expected: true`, and therefore OUT of Sentry — a pocketed phone is not a
// defect. Only a genuinely unexplained exit (`reason: 'unknown-exit'`) reports
// as a real failure, which is what puts it in Sentry under the existing
// `source: offline-sync` / `kind: snapshot-bootstrap` tags.
//
// NO BURN, EVER. Every report the guard emits carries `attempt: 0`: it is a
// bystander that never touched the retry ladder, and claiming an attempt the
// scope still has would strand a board on the paged crawl for a lock it can
// retry in two minutes.

import { classifySnapshotBootstrapFailure, type SnapshotBootstrapFailureReason } from './bootstrap-failure-reason';
import { isNetworkError } from '../mutation-queue/error-classification';
import type { SnapshotBootstrapErrorReport } from './snapshot-bootstrap';

export type BootstrapStage = SnapshotBootstrapErrorReport['stage'];

export type DownloadFunnelGuardOptions = {
  /**
   * The Failed leg. Undefined for headless callers (web, most tests) — the
   * bookkeeping still runs, it just has nowhere to report, exactly like every
   * explicit site in the phase.
   */
  report: ((report: SnapshotBootstrapErrorReport) => void) | undefined;
  /**
   * Why the cycle is being torn down AT THIS INSTANT, or null. Read at close
   * time rather than latched, so an unexplained exit during a sign-out is
   * attributed to the sign-out instead of being filed as a defect.
   */
  teardownReason: () => SnapshotBootstrapFailureReason | null;
};

export type DownloadFunnelGuard = {
  /**
   * The scope reached the Started emission point: from here to `close()` it owes
   * the funnel a terminal event.
   */
  arm(scopeKey: string, stage: BootstrapStage): void;
  /** How far this attempt got. Carried on whatever terminal event ends up firing. */
  enterStage(stage: BootstrapStage): void;
  /** A terminal event was recorded for `scopeKey` — the guard stays quiet. */
  settle(scopeKey: string): void;
  /** An exception is unwinding the phase. Reports it, classified, then stays quiet. */
  settleUncaught(error: unknown): void;
  /** Un-bypassable close-out. Call from a `finally`. */
  close(): void;
};

export function createDownloadFunnelGuard(options: DownloadFunnelGuardOptions): DownloadFunnelGuard {
  let attempt: { scopeKey: string; stage: BootstrapStage; settled: boolean } | null = null;

  const emit = (report: {
    reason: SnapshotBootstrapFailureReason;
    cause: unknown;
    aborted: boolean;
    expected: boolean;
  }): void => {
    if (!attempt) return;
    attempt.settled = true;
    options.report?.({
      scopeKey: attempt.scopeKey,
      stage: attempt.stage,
      // See NO BURN, EVER above. Zero is this field's established meaning for
      // "nothing was spent", not a placeholder.
      attempt: 0,
      cause: report.cause,
      reason: report.reason,
      aborted: report.aborted,
      expected: report.expected,
    });
  };

  return {
    arm(scopeKey, stage) {
      attempt = { scopeKey, stage, settled: false };
    },
    enterStage(stage) {
      if (attempt) attempt.stage = stage;
    },
    settle(scopeKey) {
      // Scope-checked: a report for a DIFFERENT scope (the retrofit grades path
      // runs for scopes this attempt never armed) must not close this one.
      if (attempt?.scopeKey === scopeKey) attempt.settled = true;
    },
    settleUncaught(error) {
      if (!attempt || attempt.settled) return;
      const classified = classifySnapshotBootstrapFailure(error);
      // A SnapshotWipedError classifies itself; anything else is only an abort if
      // the cycle is being torn down right now.
      const abortReason = classified === 'aborted-wipe' ? classified : options.teardownReason();
      if (abortReason) {
        emit({ reason: abortReason, cause: error, aborted: true, expected: true });
        return;
      }
      // The case the field report behind this guard is made of: a SQLite lock on
      // one of the writes that sit outside the import's own catch. Reported at
      // full severity — it is a defect, and Sentry is where it gets diagnosed.
      emit({ reason: classified, cause: error, aborted: false, expected: isNetworkError(error) });
    },
    close() {
      const closing = attempt;
      if (!closing) return;
      if (closing.settled) {
        attempt = null;
        return;
      }
      const teardown = options.teardownReason();
      if (teardown) {
        // A known bail-out that forgot to report. Same shape #4314's hand-written
        // sites emit, so the two can never disagree.
        emit({ reason: teardown, cause: null, aborted: true, expected: true });
        attempt = null;
        return;
      }
      // Nothing explains this exit. A synthetic cause rather than null so the
      // funnel's `errorMessage` and the Sentry issue both name the stage instead
      // of reading "null".
      emit({
        reason: 'unknown-exit',
        cause: new Error(`snapshot bootstrap left stage "${closing.stage}" with no terminal event`),
        aborted: false,
        expected: false,
      });
      attempt = null;
    },
  };
}
