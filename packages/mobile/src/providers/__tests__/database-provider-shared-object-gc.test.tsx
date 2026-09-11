// @vitest-environment jsdom
// #5410: garbage-collecting a STALE JS wrapper destroys the native handle the LIVE
// connection is still using.
//
// On Android, opening `boardsesh.db` twice with equal options returns the same Kotlin
// `NativeDatabase` (`SQLiteModule.kt`), and expo-modules-core registers that one
// native instance a second time under a fresh shared-object id, minting an
// independent C++ `NativeState` for the new wrapper. `~NativeState` runs the
// releaser, so collecting ANY wrapper calls `sharedObjectDidRelease()` →
// `ref.close()` → `mHybridData.resetNative()`. `NativeDatabase.kt` neither consults
// its refcount nor sets `isClosed` there, so the next call sails past
// `maybeThrowForClosedDatabase` and dereferences a freed pointer.
//
// The mock below models exactly that, which is why it is NOT shared with
// database-provider-retention.test.tsx: that suite's mock deliberately models only
// the refcount, so its assertions stay about the native free. This one is a superset
// — refcount AND shared-object registry — because the bug here is that the refcount
// is not what protects you.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

vi.mock('../../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../lib/profiling/startup-profile', () => ({ markStartup: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));

vi.mock('@boardsesh/offline-sync', () => ({
  configureMainConnection: vi.fn(async () => {}),
  ensureMutationQueueTable: vi.fn(async () => {}),
  runMigrations: vi.fn(async () => {}),
  classifySqliteLockError: () => ({ locked: false, code: null }),
  applyBusyTimeout: vi.fn(async () => {}),
  beginImmediateWrite: vi.fn(async () => {}),
  deleteUserCheckpoints: vi.fn(async () => {}),
  deleteAllSyncMeta: vi.fn(async () => {}),
  vacuumDatabase: vi.fn(async () => true),
  getUnfinishedDownloadScopeKeys: vi.fn(async () => []),
  claimAbandonedDownloadTerminal: vi.fn(() => true),
  purgeNamespaceForScopeKey: vi.fn(async () => {}),
  OFFLINE_DB_BUSY_TIMEOUT_MS: 5_000,
  BOARD_DATA_TABLES: [],
}));

/** Verbatim BOARDSESH-G1, as `CodedException.kt` renders a message-less NPE. */
const ANDROID_DEAD_HANDLE =
  "Call to function 'NativeDatabase.prepareAsync' has been rejected.\n→ Caused by: java.lang.NullPointerException: java.lang.NullPointerException";

const sqlite = vi.hoisted(() => {
  type NativeConnection = { id: number; path: string; refCount: number; freed: boolean; destroyed: boolean };
  type Wrapper = {
    sharedObjectId: number;
    native: NativeConnection;
    databasePath: string;
    options: { useNewConnection?: boolean };
    nativeDatabase: object;
    prepareAsync: (source: string) => Promise<void>;
    closeAsync: () => Promise<void>;
    withExclusiveTransactionAsync: (task: (txn: unknown) => Promise<void>) => Promise<void>;
  };

  const cache = new Map<string, NativeConnection>();
  /** `SharedObjectRegistry.pairs`: id -> native. One entry PER WRAPPER. */
  const registry = new Map<number, NativeConnection>();
  const wrappers: Wrapper[] = [];
  const freedConnectionIds: number[] = [];
  let nextConnectionId = 0;
  let nextSharedObjectId = 0;
  /** When true, the provider publishes without ever calling `onInit` (see test 5). */
  let skipOnInit = false;

  function openNative(path: string, useNewConnection: boolean): NativeConnection {
    // The constructor predicate short-circuits on `!options.useNewConnection`, so a
    // transaction open can never be served from — or matched against — the cache.
    if (!useNewConnection) {
      const cached = cache.get(path);
      if (cached !== undefined) {
        cached.refCount += 1;
        return cached;
      }
    }
    nextConnectionId += 1;
    const connection: NativeConnection = { id: nextConnectionId, path, refCount: 1, freed: false, destroyed: false };
    if (!useNewConnection) cache.set(path, connection);
    return connection;
  }

  function makeWrapper(path: string, options: { useNewConnection?: boolean }): Wrapper {
    const native = openNative(path, options.useNewConnection === true);
    nextSharedObjectId += 1;
    const sharedObjectId = nextSharedObjectId;
    // `SharedObjectRegistry.add()` mints a new id and OVERWRITES the one the native
    // object was carrying. This single line is the bug.
    registry.set(sharedObjectId, native);

    const wrapper: Wrapper = {
      sharedObjectId,
      native,
      databasePath: path,
      options,
      nativeDatabase: { sharedObjectId },
      prepareAsync: async (): Promise<void> => {
        if (native.destroyed) throw new Error(ANDROID_DEAD_HANDLE);
        if (native.freed) throw new Error('Access to closed resource');
      },
      closeAsync: async (): Promise<void> => {
        native.refCount -= 1;
        if (native.refCount > 0) return;
        native.freed = true;
        cache.delete(native.path);
        freedConnectionIds.push(native.id);
      },
      withExclusiveTransactionAsync: async (task): Promise<void> => {
        const txn = makeWrapper(path, { ...options, useNewConnection: true });
        try {
          await task(txn);
        } finally {
          await txn.closeAsync();
        }
      },
    };
    wrappers.push(wrapper);
    return wrapper;
  }

  return {
    makeWrapper,
    freedConnectionIds,
    allWrappers: (): Wrapper[] => [...wrappers],
    liveConnections: (): { id: number; refCount: number }[] =>
      [...cache.values()].map(({ id, refCount }) => ({ id, refCount })),
    /**
     * The collector reclaimed `wrapper`: `~NativeState` runs the releaser, the
     * registry entry goes, and `sharedObjectDidRelease()` closes the native binding.
     *
     * Deliberately touches NEITHER `refCount` NOR `freed` — that asymmetry IS the
     * bug, and a mock that tidied it up would stop reproducing anything.
     */
    collect(wrapper: Wrapper): void {
      registry.delete(wrapper.sharedObjectId);
      wrapper.native.destroyed = true;
    },
    setSkipOnInit(value: boolean): void {
      skipOnInit = value;
    },
    shouldSkipOnInit: (): boolean => skipOnInit,
    reset(): void {
      cache.clear();
      registry.clear();
      wrappers.length = 0;
      freedConnectionIds.length = 0;
      nextConnectionId = 0;
      nextSharedObjectId = 0;
      skipOnInit = false;
    },
  };
});

vi.mock('expo-sqlite', async () => {
  const { createContext, createElement, useContext, useEffect, useRef, useState } = await import('react');
  const SQLiteContext = createContext<unknown>(null);

  async function openDatabaseAsync(databaseName: string, options?: { useNewConnection?: boolean }): Promise<unknown> {
    return sqlite.makeWrapper(databaseName, options ?? {});
  }

  function SQLiteProvider({
    children,
    databaseName,
    onInit,
  }: {
    children?: unknown;
    databaseName: string;
    onInit: (db: never) => Promise<void>;
  }) {
    const databaseRef = useRef<{ closeAsync: () => Promise<void> } | null>(null);
    const [, setOpened] = useState(false);

    useEffect(() => {
      async function setup(): Promise<void> {
        const database = (await openDatabaseAsync(databaseName)) as { closeAsync: () => Promise<void> };
        if (!sqlite.shouldSkipOnInit()) await onInit(database as never);
        databaseRef.current = database;
        setOpened(true);
      }
      void setup();
      return () => {
        const database = databaseRef.current;
        databaseRef.current = null;
        setOpened(false);
        void database?.closeAsync();
      };
    }, [databaseName, onInit]);

    if (databaseRef.current === null) return null;
    return createElement(SQLiteContext.Provider, { value: databaseRef.current }, children as never);
  }

  return { SQLiteProvider, openDatabaseAsync, useSQLiteContext: () => useContext(SQLiteContext) };
});

import { DatabaseProvider } from '../database-provider';
import { getDatabaseHandle, setDatabaseHandle } from '../../db/connection';
import { resetDatabaseInitializationForTests, resetDatabasePinsForTests } from '../../db/testing';
import { isDatabasePinned, pinnedDatabaseCount } from '../../db/connection-pin';
import { resetConnectionRetentionForTests } from '../../db/connection-retention';

beforeEach(() => {
  resetDatabaseInitializationForTests();
  resetConnectionRetentionForTests();
  resetDatabasePinsForTests();
  setDatabaseHandle(null);
  sqlite.reset();
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountUntilPublished(): Promise<{ unmount: () => void }> {
  const view = render(
    <DatabaseProvider>
      <div data-testid="child" />
    </DatabaseProvider>,
  );
  await waitFor(() => {
    expect(view.queryByTestId('child')).not.toBeNull();
  });
  await settle();
  return view;
}

/**
 * Run the collector over everything production did NOT pin.
 *
 * Asserts the production invariant directly — it calls `isDatabasePinned` rather than
 * restating which wrappers ought to be pinned, so a funnel that stops firing shows up
 * here as a destroyed connection instead of as a stale expectation.
 */
function collectUnpinned(): void {
  for (const wrapper of sqlite.allWrappers()) {
    if (!isDatabasePinned(wrapper as never)) sqlite.collect(wrapper);
  }
}

describe('the mock still reproduces BOARDSESH-G1', () => {
  // If this ever stops failing, every other test in this file is vacuous.
  it('kills the live connection when a second wrapper over it is collected', async () => {
    const first = sqlite.makeWrapper('boardsesh.db', {});
    const second = sqlite.makeWrapper('boardsesh.db', {});
    expect(second.native).toBe(first.native);
    expect(first.native.refCount).toBe(2);

    sqlite.collect(first);

    // Nothing was closed and nothing was freed — the refcount is still 2 — and yet
    // the live wrapper's next statement hits a freed pointer.
    expect(first.native.freed).toBe(false);
    expect(first.native.refCount).toBe(2);
    await expect(second.prepareAsync('SELECT 1')).rejects.toThrow('java.lang.NullPointerException');
  });
});

describe('DatabaseProvider shared-object pinning', () => {
  it('leaves the live connection usable after a teardown and a collection', async () => {
    const first = await mountUntilPublished();
    first.unmount();
    await settle();

    const second = await mountUntilPublished();
    collectUnpinned();

    const live = sqlite.allWrappers().at(-1);
    expect(live).toBeDefined();
    await expect(live?.prepareAsync('SELECT 1')).resolves.toBeUndefined();
    expect(sqlite.liveConnections()).toEqual([{ id: 1, refCount: expect.any(Number) }]);
    expect(sqlite.allWrappers().every((wrapper) => !wrapper.native.destroyed)).toBe(true);

    second.unmount();
    await settle();
  });

  it('survives ten remounts with a collection after each', async () => {
    for (let mount = 0; mount < 10; mount += 1) {
      const view = await mountUntilPublished();
      view.unmount();
      await settle();
      collectUnpinned();
    }

    // One native connection for the whole process, never freed, never destroyed.
    expect(sqlite.freedConnectionIds).toEqual([]);
    expect(sqlite.allWrappers().every((wrapper) => !wrapper.native.destroyed)).toBe(true);
    expect(pinnedDatabaseCount()).toBeGreaterThanOrEqual(10);
  });

  it('pins the retention handle', async () => {
    await mountUntilPublished();
    const retained = sqlite.allWrappers().filter((wrapper) => wrapper.options.useNewConnection !== true);
    expect(retained.length).toBeGreaterThanOrEqual(2);
    expect(retained.every((wrapper) => isDatabasePinned(wrapper as never))).toBe(true);
  });

  it('pins a context value onInit never saw', async () => {
    // Today `SQLiteProvider` cannot do this. The effect pin is what keeps that from
    // being load-bearing on an undocumented expo-sqlite internal.
    sqlite.setSkipOnInit(true);
    await mountUntilPublished();

    const published = sqlite.allWrappers().at(-1);
    expect(published).toBeDefined();
    expect(isDatabasePinned(published as never)).toBe(true);
  });

  it('never pins a transaction connection', async () => {
    await mountUntilPublished();
    const before = pinnedDatabaseCount();

    const live = sqlite.allWrappers().at(-1);
    for (let write = 0; write < 100; write += 1) {
      await live?.withExclusiveTransactionAsync(async () => {});
    }

    // Pinning these would leak one connection object per offline write — the one way
    // this module could become a problem of its own.
    expect(pinnedDatabaseCount()).toBe(before);
    expect(sqlite.allWrappers().filter((wrapper) => wrapper.options.useNewConnection === true)).toHaveLength(100);
  });

  it('keeps publishing independent of pinning', async () => {
    const view = await mountUntilPublished();
    const published = sqlite.allWrappers().at(-1);

    view.unmount();
    await settle();

    // Pinned for reachability, retracted for liveness. Orthogonal axes.
    expect(isDatabasePinned(published as never)).toBe(true);
    expect(getDatabaseHandle()).toBeNull();
  });
});
