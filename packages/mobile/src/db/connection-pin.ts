// Every JS wrapper we have ever seen for `boardsesh.db`, held strongly, forever.
//
// WHY (#5410). On Android, opening the app database a second time with equal
// options does NOT open a second connection — `SQLiteModule.kt`'s constructor
// finds the cached one and hands it straight back:
//
//   findCachedDatabase { it.databasePath == databasePath && it.openOptions == options
//                        && !options.useNewConnection }?.let { it.addRef(); return@Constructor it }
//
// expo-modules-core then registers that ONE native instance a second time
// (`SharedObjectRegistry.add()`), minting a fresh id and an independent C++
// `NativeState` for the new JS wrapper. `~NativeState` runs the releaser, so when
// the garbage collector reclaims ANY of those wrappers, `SharedObjectRegistry.delete`
// calls `NativeDatabase.sharedObjectDidRelease()` → `ref.close()` →
// `mHybridData.resetNative()` — on the connection every OTHER wrapper is still using.
//
// `NativeDatabase.kt` neither consults its refcount nor sets `isClosed` there, so
// `maybeThrowForClosedDatabase` still waves the next call through and
// `sqlite3_prepare_v2` dereferences a freed pointer. That is BOARDSESH-G1: a
// message-less `java.lang.NullPointerException` from a database nothing closed,
// after which every read, every sync cycle and every tick write fails until the
// climber force-quits (239 users / 2593 events over 30 days).
//
// So the fix is reachability, not refcounting: a wrapper that can never become
// garbage can never run its releaser. We create wrappers from four places — the
// retention handle (#5300), every `SQLiteProvider` mount, `latestDatabase` in
// `connection.ts` (which is OVERWRITTEN on each remount, and that overwrite is what
// makes the previous wrapper collectable), and the dev lock holder — and all four
// funnel through `pinDatabase`.
//
// THE SET IS STRONG, AND THAT IS THE POINT. `WeakSet`, `WeakRef` and
// `FinalizationRegistry` all let the collector reclaim the wrapper, which is
// precisely the bug. Do not "optimise" this into a weak container, and do not add
// eviction at any bound: the entry you evict may be the one whose collection kills
// the live connection.
//
// This is ORTHOGONAL to `setDatabaseHandle(null)` / `releaseDatabaseHandle` /
// `retractSupersededHandle` in `connection.ts`. Those are about LIVENESS — never
// hand a reader a connection the provider has closed (#5292, #5366). This is about
// REACHABILITY — never let a wrapper be collected. Both are still needed; neither
// replaces the other.
//
// iOS is unaffected: `SharedObjectRegistry.swift` reuses the id and native state for
// a second registration, and the iOS `NativeDatabase` does not override
// `sharedObjectDidRelease` at all. This is an Android-only parity gap in
// expo-modules-core, filed upstream; we cannot patch it here because `patches/` is
// hashed into the native fingerprint, so a patched fix could not reach the affected
// users by OTA.

import type { SQLiteDatabase } from 'expo-sqlite';
import { reportError } from '../lib/error-reporting';
import { DATABASE_NAME } from './database-name';

/**
 * Deliberately strong, deliberately never cleared. Holds both the `SQLiteDatabase`
 * wrapper and its `nativeDatabase`: the wrapper transitively retains the native
 * object today, but the `NativeState` lives on the NATIVE one, so pinning it
 * directly means an upstream refactor of the wrapper cannot silently un-pin us.
 */
const pinned = new Set<object>();

/** Mounts pinned, not set size — each mount contributes two entries. */
let pinnedMounts = 0;

/**
 * Above this many mounts something is remounting the provider in a loop, which is
 * worth knowing about: the production remount rate is currently unmeasured, and it
 * is what decides whether this set's growth ever matters. Reported once, never
 * acted on — see the eviction warning in the header.
 */
const PIN_COUNT_REPORT_THRESHOLD = 20;
let hasReportedPinGrowth = false;

/**
 * Pin a connection so garbage collection can never destroy the native handle behind it.
 *
 * Idempotent and tolerant of null/undefined, because it is called from `onInit`, from
 * an effect, and from the init chain — all of which can see the same connection.
 */
export function pinDatabase(db: SQLiteDatabase | null | undefined): void {
  if (db === null || db === undefined) return;

  // Transaction connections must NOT be pinned. `withExclusiveTransactionAsync` opens
  // with `useNewConnection: true`, and the constructor predicate above short-circuits
  // on that flag — so a transaction gets a genuinely separate `NativeDatabase` whose
  // release is correct and whose `closeAsync` really does set `isClosed`. Pinning them
  // would leak one connection object per offline write, which is the one way this
  // module could become a problem of its own. This line is what bounds the set.
  if (db.options?.useNewConnection === true) return;

  // Cheap honesty check: if a second database ever appears, it gets its own module
  // rather than quietly sharing this one's lifetime.
  if (typeof db.databasePath === 'string' && !db.databasePath.endsWith(DATABASE_NAME)) return;

  if (pinned.has(db)) return;
  pinned.add(db);
  const native: unknown = (db as { nativeDatabase?: unknown }).nativeDatabase;
  if (typeof native === 'object' && native !== null) pinned.add(native);
  pinnedMounts += 1;

  // Fast Refresh pins on every reload, so this would fire constantly in development.
  if (!__DEV__ && !hasReportedPinGrowth && pinnedMounts > PIN_COUNT_REPORT_THRESHOLD) {
    hasReportedPinGrowth = true;
    reportError(new Error(`SQLite connections pinned: ${pinnedMounts}`), {
      tags: { source: 'offline-sync', kind: 'sqlite-pin-growth' },
      extra: { pinnedMounts },
    });
  }
}

/** Whether `db` is pinned. The GC simulation in the tests asserts against this. */
export function isDatabasePinned(db: SQLiteDatabase | null | undefined): boolean {
  return db !== null && db !== undefined && pinned.has(db);
}

/** How many connections have been pinned, counting one per mount rather than per entry. */
export function pinnedDatabaseCount(): number {
  return pinnedMounts;
}

/** Test-only. Drops every pin so a suite can drive the first-mount path more than once. */
export function resetDatabasePinsForTests(): void {
  pinned.clear();
  pinnedMounts = 0;
  hasReportedPinGrowth = false;
}
