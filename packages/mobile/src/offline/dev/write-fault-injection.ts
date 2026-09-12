// Dev-only fault injection for local SQLite writes (issue #4315).
//
// The retry ladder and the tick degrade branch cannot be reached by ordinary
// use: measured import windows all fit inside the shipped 5s `busy_timeout`, so
// "log a tick during a board download" just produces a normal fast save. The
// sibling `lock-holder.ts` produces REAL contention, which is the only way to
// prove the platform's genuine lock string is matched; this module covers the
// shapes a real lock cannot schedule precisely — a specific number of failures,
// a non-lock error, and the commit-then-throw case that motivates the
// `INSERT OR IGNORE` on the tick insert.
//
// Consumed only from inside `if (__DEV__)` in `runLocalWrite`, so Metro's
// minifier drops the branch in release; nothing here runs at import time.
//
// The lock strings are copied from the shapes `@boardsesh/offline-sync`'s
// lock-errors.ts documents from real Sentry events, including the raw U+0005
// byte Android emits where the result-code digit belongs. Built with
// fromCharCode for the same reason lock-errors.ts does: no raw control byte in
// source.

export type WriteFaultMode =
  | 'off'
  | 'ios-lock'
  | 'android-lock'
  | 'android-lock-no-code'
  | 'disk-full'
  | 'commit-then-throw'
  | 'android-dead-handle'
  | 'closed-resource';

export type WriteFaultPhase = 'before-task' | 'after-commit';

const BUSY_CONTROL_BYTE = String.fromCharCode(5);

const IOS_LOCK_MESSAGE =
  "FunctionCallException: Calling the 'prepareAsync' function has failed\n→ Caused by: SQLiteErrorException: Error code 5: database is locked";
const ANDROID_LOCK_MESSAGE =
  "Call to function 'NativeDatabase.prepareAsync' has been rejected.\n→ Caused by: Error code " +
  BUSY_CONTROL_BYTE +
  ': database is locked';
const ANDROID_LOCK_NO_CODE_MESSAGE =
  "Call to function 'NativeDatabase.prepareAsync' has been rejected.\n→ Caused by: Error code : database is locked";
// #5410. Not a lock at all: a collected JS wrapper freed the native binding, so the
// call sails past expo-sqlite's `isClosed` guard and dereferences a dead pointer.
// `CodedException.kt` renders the cause as `localizedMessage ?: cause`, and
// `toString()` on a message-less NullPointerException is the bare class name — which
// is why there is nothing after the final colon to key on.
const ANDROID_DEAD_HANDLE_MESSAGE =
  "Call to function 'NativeDatabase.prepareAsync' has been rejected.\n→ Caused by: java.lang.NullPointerException: java.lang.NullPointerException";
// The honest close, which expo-sqlite raises itself when `isClosed` really was set.
const CLOSED_RESOURCE_MESSAGE = 'Access to closed resource';
const DISK_FULL_MESSAGE =
  "FunctionCallException: Calling the 'runAsync' function has failed\n→ Caused by: SQLiteErrorException: Error code 13: database or disk is full";

const FAULT_MESSAGES: Record<Exclude<WriteFaultMode, 'off'>, string> = {
  'ios-lock': IOS_LOCK_MESSAGE,
  'android-lock': ANDROID_LOCK_MESSAGE,
  'android-lock-no-code': ANDROID_LOCK_NO_CODE_MESSAGE,
  'disk-full': DISK_FULL_MESSAGE,
  // The lock shape matters here too: a commit-then-throw only retries when the
  // ladder classifies it as contention, which is the case being reproduced.
  'commit-then-throw': IOS_LOCK_MESSAGE,
  'android-dead-handle': ANDROID_DEAD_HANDLE_MESSAGE,
  'closed-resource': CLOSED_RESOURCE_MESSAGE,
};

/**
 * The dead-handle message, exported so the dev screen can drive the FULL recovery
 * loop — detect, re-open, republish, restart the scheduler — rather than only the
 * classification on the tick path. A genuine kill is not reproducible on demand:
 * Hermes exposes no forced garbage collection, which is exactly why this bug reads
 * as background noise instead of something QA can find.
 */
export { ANDROID_DEAD_HANDLE_MESSAGE };

type WriteFaultState = { mode: WriteFaultMode; remaining: number };

const state: WriteFaultState = { mode: 'off', remaining: 0 };

/**
 * Arm the injector. `failAttempts` is how many write attempts should fail
 * before it disarms itself — 1 exercises "the retry recovers", a large number
 * exercises "the ladder is exhausted and the caller degrades".
 */
export function setWriteFault(mode: WriteFaultMode, failAttempts: number): void {
  state.mode = mode;
  state.remaining = mode === 'off' ? 0 : Math.max(0, failAttempts);
}

export function getWriteFault(): WriteFaultState {
  return { mode: state.mode, remaining: state.remaining };
}

/**
 * Take one injected fault for this phase, or null.
 *
 * `commit-then-throw` fires only AFTER the transaction resolved — the exact
 * shape a `SQLITE_BUSY` at COMMIT produces, and the only way to exercise the
 * tick insert's idempotency on a device. Every other mode fires before the
 * transaction opens.
 */
export function takeInjectedWriteFault(phase: WriteFaultPhase): Error | null {
  const armedMode = state.mode;
  if (armedMode === 'off' || state.remaining <= 0) return null;
  const firesAfterCommit = armedMode === 'commit-then-throw';
  if (firesAfterCommit !== (phase === 'after-commit')) return null;

  state.remaining -= 1;
  if (state.remaining <= 0) state.mode = 'off';
  return new Error(FAULT_MESSAGES[armedMode]);
}
