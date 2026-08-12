// "Is this SQLite write-lock contention?" — one predicate, shared.
//
// Every `kind: 'tick-local-write'` failure in Sentry over 90 days is a
// `database is locked`, and #4314 needs the same test to decide whether a
// failed local write is contention (worth deferring/retrying) or a genuinely
// broken database (disk full, corruption). Keeping one implementation here
// stops the two workstreams from drifting apart on which strings count.
//
// Matching rules, in order of trust:
//   1. `database is locked` / `SQLITE_BUSY` — the primary, stable signal.
//   2. The numeric result code, and only as a SECONDARY signal, because the
//      real Android strings carry a raw control byte (U+0005) where the digit
//      belongs — "Error code <U+0005>: database is locked" (BOARDSESH-6V, all
//      18 events) — while iOS and newer builds carry a plain "Error code 5:".
//      A matcher keyed on the literal text "Error code 5" misses every Android
//      event; a matcher keyed only on the code would also swallow unrelated
//      SQLITE_ result codes, so it never fires on its own.
//
// Walks the `.cause` chain to the same depth error-classification.ts uses —
// expo-sqlite wraps the driver error ("Calling the 'execAsync' function has
// failed" → cause: the real one).

const MAX_CAUSE_DEPTH = 3;

/** The stable, locale-independent identifiers for write-lock contention. */
const LOCK_MARKERS = /database is locked|database table is locked|sqlite_busy|sqlite_locked/i;

/**
 * SQLite result code 5 (SQLITE_BUSY) as it appears in a driver message: either
 * the literal digit or the raw U+0005 byte Android emits, followed by a colon.
 *
 * Built with fromCharCode rather than written as a literal so no raw control
 * byte ever lands in this source file — one would make the file "binary" to
 * grep and is trivially lost to a copy/paste or a formatter pass.
 */
const BUSY_CONTROL_BYTE = String.fromCharCode(5);
const BUSY_RESULT_CODE = new RegExp(`error code\\s*(?:${BUSY_CONTROL_BYTE}|5)\\s*:`, 'i');

function messageOf(error: unknown): string | null {
  if (typeof error === 'string') return error;
  if (error === null || typeof error !== 'object') return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : null;
}

function isLockedAtDepth(error: unknown, depth: number): boolean {
  if (error === null || error === undefined) return false;

  const message = messageOf(error);
  if (message !== null) {
    if (LOCK_MARKERS.test(message)) return true;
    // Secondary: the busy result code only counts when the message ALSO says
    // something about a lock. On its own it would swallow unrelated errors that
    // happen to carry an "Error code N:" prefix.
    if (BUSY_RESULT_CODE.test(message) && /lock/i.test(message)) return true;
  }

  if (typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && LOCK_MARKERS.test(code)) return true;

    if (depth < MAX_CAUSE_DEPTH) {
      const cause = (error as { cause?: unknown }).cause;
      if (cause !== undefined && cause !== error && isLockedAtDepth(cause, depth + 1)) return true;
    }
  }

  return false;
}

/**
 * True when `error` (or anything up to three `.cause` links deep) is SQLite
 * write-lock contention rather than a broken database.
 */
export function isDatabaseLockedError(error: unknown): boolean {
  return isLockedAtDepth(error, 0);
}
