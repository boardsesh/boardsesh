// The notifier that turns "some call failed" into "the SQLite handle is gone,
// re-open it" (#5410).
//
// WHY A REGISTRATION SEAM RATHER THAN A DIRECT CALL. Detection has to hang off
// `reportError`, because that is the one funnel every SQLite consumer already
// passes through — react-query reads and mutations, the sync cycle, tick writes,
// and the init chain itself. But `lib/error-reporting` → `db/connection` →
// `lib/error-reporting` is an import cycle, and `connection.ts` is what owns the
// re-open. So `connection.ts` registers its recovery here on module load, and this
// module stays a leaf that imports nothing but the classifier.
//
// WHY IT IS SAFE TO CALL FROM INSIDE THE REPORTING FUNNEL. `noteDatabaseHandleFailure`
// never throws and never awaits: it classifies, and hands off to a recovery that
// starts its own work asynchronously. A reporting path that could throw would turn
// every handled error into an unhandled one.

import { classifySqliteHandleError, type SqliteHandleFailure } from '@boardsesh/offline-sync';

/** Which consumer hit the dead handle first. Tagged on the recovery report. */
export type DeadHandleOrigin = 'report' | 'cycle' | 'init' | 'dev';

type RecoveryStart = (shape: Exclude<SqliteHandleFailure, null>, origin: DeadHandleOrigin) => void;

let startRecovery: RecoveryStart | null = null;

/**
 * Wire the recovery. Called once, from `connection.ts`'s module body, so the
 * registration cannot be forgotten by a caller and cannot arrive after the first
 * failure.
 */
export function registerDeadHandleRecovery(start: RecoveryStart): void {
  startRecovery = start;
}

/**
 * Classify `error` and, if the handle behind it is dead, kick off recovery.
 *
 * Returns whether it was a handle failure, so a caller that also reports can tag
 * its own report and keep the aggregate sliceable.
 */
export function noteDatabaseHandleFailure(error: unknown, origin: DeadHandleOrigin): boolean {
  const shape = classifySqliteHandleError(error);
  if (shape === null) return false;
  startRecovery?.(shape, origin);
  return true;
}

/** Test-only. Drops the registration so a suite can assert the unwired case. */
export function resetDeadHandleStateForTests(): void {
  startRecovery = null;
}
