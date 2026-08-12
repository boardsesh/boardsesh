// "Is this SQLite write-lock contention?" — one predicate, shared.
//
// Every `kind: 'tick-local-write'` failure in Sentry over 90 days is a
// `database is locked`, and #4314 needs the same test to decide whether a
// failed local write is contention (worth deferring/retrying) or a genuinely
// broken database (disk full, corruption). Keeping one implementation here
// stops the two workstreams from drifting apart on which strings count.
//
// Two entry points share that matcher:
//   - `isDatabaseLockedError` — the yes/no question reporting asks.
//   - `classifySqliteLockError` — the same verdict plus the numeric result
//     code, which the mobile sqlite-init retry loop tags its failure and
//     recovery events with.
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
// failed" → cause: the real one). Both platforms ALSO concatenate the cause
// into the outer `message` (iOS `Exception.swift`, Android `CodedException.kt`),
// so the message test carries the shapes that arrive with no structured cause:
//   iOS 2.2.2  "Calling the 'prepareAsync' function has failed → Caused by:
//               Error code 5: database is locked"
//   iOS 2.3.x  "FunctionCallException: ...\n→ Caused by: SQLiteErrorException:
//               Error code 5: database is locked"
//   Android    "Call to function 'NativeDatabase.prepareAsync' has been rejected.\n
//               → Caused by: Error code : database is locked"   ← NO numeric code

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

/** SQLITE_BUSY — another connection holds the lock this statement needs. */
const SQLITE_BUSY = 5;
/** SQLITE_LOCKED — a lock conflict inside the same database connection. */
const SQLITE_LOCKED = 6;

/** Result of reading a thrown value as a SQLite lock failure. */
export type SqliteLockClassification = {
  /** True when another writer/reader held the file and a retry could win. */
  locked: boolean;
  /**
   * The SQLite result code as reported, or null when the message carried none
   * (the Android shape above). Kept RAW rather than reduced to its primary code so
   * telemetry can still tell an extended code (e.g. 261 SQLITE_BUSY_RECOVERY) from
   * a plain 5.
   */
  code: number | null;
};

const RESULT_CODE_PATTERN = /Error code (\d+)/;

/**
 * Read a thrown value as a SQLite lock failure, for callers that also report
 * which result code came back.
 *
 * A numeric result code wins when present: it is unambiguous, and it keeps a
 * message that merely mentions locking (a wrapped disk-I/O error whose prose
 * happens to include the phrase) from being retried forever. SQLite's extended
 * result codes pack the primary code in the low byte, so the comparison masks it —
 * 261 (SQLITE_BUSY_RECOVERY) and 517 (SQLITE_BUSY_SNAPSHOT) are both retryable
 * contention, and treating them as unknown would report a transient failure.
 *
 * With no code to read — the Android shape, which prints the digit as a raw
 * control byte or omits it entirely — the verdict comes from
 * `isDatabaseLockedError`, so the two entry points can never disagree about
 * which strings count as contention.
 */
export function classifySqliteLockError(error: unknown): SqliteLockClassification {
  const message = error instanceof Error ? error.message : String(error);
  const codeMatch = RESULT_CODE_PATTERN.exec(message);

  if (codeMatch) {
    const code = Number.parseInt(codeMatch[1], 10);
    const primaryCode = code & 0xff;
    return { locked: primaryCode === SQLITE_BUSY || primaryCode === SQLITE_LOCKED, code };
  }

  return { locked: isDatabaseLockedError(error), code: null };
}
