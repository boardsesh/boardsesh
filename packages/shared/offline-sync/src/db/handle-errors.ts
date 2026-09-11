// "Is the native SQLite handle behind this error dead?" — the question
// `lock-errors.ts` deliberately does not answer.
//
// WHY THIS IS NOT A LOCK (#5410). On Android, opening `boardsesh.db` a second
// time with equal options returns the SAME Kotlin `NativeDatabase`
// (`SQLiteModule.kt`, `findCachedDatabase { ... }?.let { it.addRef() }`), but
// expo-modules-core's `SharedObjectRegistry.add()` registers that one native
// instance under a NEW id and mints an independent C++ `NativeState` for it.
// `~NativeState` runs the releaser, so garbage-collecting ANY stale JS wrapper
// calls `sharedObjectDidRelease()` → `ref.close()` → `mHybridData.resetNative()`
// on the connection every other wrapper is still using. `NativeDatabase.kt`
// neither consults the refcount nor sets `isClosed`, so the `isClosed` guard
// still passes and `sqlite3_prepare_v2` dereferences a freed hybrid pointer.
//
// The result is a message-less `java.lang.NullPointerException`, which carries
// none of the lock markers — so `classifySqliteLockError` correctly returns
// `locked: false` and every caller treats it as a permanent, non-retryable
// broken database. It is neither: the FILE is fine, the HANDLE is gone, and the
// fix is to re-open rather than to retry. That is the distinction this file
// draws.
//
// iOS never produces the NPE shape (`SharedObjectRegistry.swift` reuses the id
// and native state for a second registration, and the iOS `NativeDatabase` does
// not override `sharedObjectDidRelease`), but it does produce the `closed`
// shape when a connection really was closed underneath a reader (#5292), and
// that is recovered the same way.
//
// The matcher is deliberately CONJUNCTIVE. A bare NullPointerException is the
// most common native error there is; treating one as a dead database would make
// every unrelated Android module failure re-open SQLite. A verdict needs the
// expo-sqlite rejection frame AND the NPE, which is why the markers are tested
// against the joined chain (`chainMessage`) rather than frame by frame — real
// payloads split them across `.cause`.

import { chainMessage } from './error-cause-walk';

/**
 * `Access to closed resource` — expo-sqlite's own `AccessClosedResourceException`
 * (`SQLExceptions.kt`, `SQLiteModule.swift`), raised when `isClosed` was actually
 * set. Unambiguous on both platforms and needs no second marker.
 */
const CLOSED_MARKER = /access to closed resource/i;

/**
 * The expo-sqlite rejection frame. Covers all three shared classes because the
 * same dead binding surfaces through whichever entry point runs next — most
 * often `NativeDatabase.prepareAsync` (every `runAsync`/`getAllAsync` prepares
 * first), but `execAsync` and the `NativeStatement` methods reach it too.
 */
const EXPO_SQLITE_FRAME =
  /(?:call to function|calling the)\s+'(?:NativeDatabase|NativeStatement|NativeSession)\.\w+'|'(?:NativeDatabase|NativeStatement|NativeSession)\.\w+'\s+function/i;

/**
 * The freed-pointer signature. `FunctionCallException` renders its cause with
 * `cause.localizedMessage ?: cause` (`CodedException.kt`), and `toString()` on a
 * message-less NPE is the bare class name — so this is what reaches Sentry
 * verbatim, with no message after the colon to key on.
 */
const NULL_POINTER = /java\.lang\.NullPointerException/;

/**
 * How the handle failed, or null when the error is not a handle failure at all.
 *
 * - `dead-native-handle` — the binding was freed under us (#5410). Re-open.
 * - `closed` — the connection was genuinely closed (#5292). Also re-open.
 *
 * Both recover the same way; they are kept apart so telemetry can tell the
 * Android GC bug from an ordinary teardown race without forking the aggregate.
 */
export type SqliteHandleFailure = 'dead-native-handle' | 'closed' | null;

/**
 * Read a thrown value as a dead-handle failure.
 *
 * Returns null for lock contention, disk-full, corruption and every ordinary
 * error — those keep their existing handling. This never overlaps
 * `isDatabaseLockedError`: the pinned shapes carry no lock marker and no
 * `Error code N:` prefix, and `handle-errors.test.ts` asserts that in both
 * directions so the two matchers cannot start agreeing.
 */
export function classifySqliteHandleError(error: unknown): SqliteHandleFailure {
  const message = chainMessage(error);
  if (message === '') return null;

  if (CLOSED_MARKER.test(message)) return 'closed';
  if (EXPO_SQLITE_FRAME.test(message) && NULL_POINTER.test(message)) return 'dead-native-handle';

  return null;
}

/** True when the handle behind `error` is unusable and only a re-open can fix it. */
export function isDeadDatabaseHandleError(error: unknown): boolean {
  return classifySqliteHandleError(error) !== null;
}
