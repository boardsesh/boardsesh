// @vitest-environment jsdom
// #5300: `SQLiteProvider`'s effect teardown closes its connection, and expo-sqlite's
// close frees the `sqlite3*` and finalizes every statement on it while other queries
// are still running on the module's concurrent dispatch queue — a native
// use-after-free, not a JS error anyone can catch. #5336 stopped new readers picking
// up a closed connection; it cannot reach a reader already mid-`await`.
//
// The fix is to hold one process-lifetime reference, so the provider's close is never
// the last one out. This suite models the piece of expo-sqlite that makes that work:
// its native connection cache is REFCOUNTED — opening the same path with the same
// options returns the cached `NativeDatabase` and `addRef()`s it, and `closeAsync`
// reaches `exsqlite3_close` only when the count falls to zero (iOS
// `SQLiteModule.swift` / Android `SQLiteModule.kt`, identical on both). The assertion
// is therefore about the native free, which is the thing that crashes: after the
// provider tears down, nothing may have been freed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';

vi.mock('../../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../lib/profiling/startup-profile', () => ({ markStartup: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));

// The real engine runs SQL, and its node:sqlite test adapter cannot be bundled into
// this file's jsdom environment. The DDL is covered against the REAL schema in
// db/__tests__/connection.test.ts; all this suite needs from the setup sequence is
// that it succeeds, so the provider gets far enough to publish and then tear down.
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

// expo-sqlite's native side, reduced to the two things that decide whether a teardown
// crashes: the refcounted connection cache, and a provider that opens through it.
// vi.hoisted because the mock factory below is hoisted above this file's imports.
const sqlite = vi.hoisted(() => {
  type NativeConnection = { id: number; path: string; refCount: number; freed: boolean };

  const cache = new Map<string, NativeConnection>();
  const freedConnectionIds: number[] = [];
  const openedConnectionIds: number[] = [];
  let nextConnectionId = 0;

  // `openDatabaseAsync` awaits `ensureDatabasePathExistsAsync` BEFORE it reaches the
  // constructor that bumps the refcount, so the reference does not exist the moment
  // the call is made. This models that gap: opens past `ungatedOpens` wait until the
  // test releases them.
  let ungatedOpens = Number.POSITIVE_INFINITY;
  let gate: Promise<void> | null = null;
  let openCalls = 0;

  async function awaitOpenGate(): Promise<void> {
    openCalls += 1;
    if (openCalls > ungatedOpens && gate !== null) await gate;
  }

  // `NativeDatabase`'s constructor: a cached connection for the same path is reused
  // and its refcount bumped; only a cache miss opens a new `sqlite3*`.
  function openNative(path: string): NativeConnection {
    const cached = cache.get(path);
    if (cached !== undefined) {
      cached.refCount += 1;
      openedConnectionIds.push(cached.id);
      return cached;
    }
    nextConnectionId += 1;
    const connection: NativeConnection = { id: nextConnectionId, path, refCount: 1, freed: false };
    cache.set(path, connection);
    openedConnectionIds.push(connection.id);
    return connection;
  }

  // `closeAsync` -> `removeCachedDatabase`: decrement, and free only at zero.
  function closeNative(connection: NativeConnection): void {
    connection.refCount -= 1;
    if (connection.refCount > 0) return;
    connection.freed = true;
    cache.delete(connection.path);
    freedConnectionIds.push(connection.id);
  }

  return {
    liveConnections(): { id: number; refCount: number }[] {
      return [...cache.values()].map(({ id, refCount }) => ({ id, refCount }));
    },
    freedConnectionIds,
    openedConnectionIds,
    openNative,
    closeNative,
    awaitOpenGate,
    /** Stall every open past the first `count`; returns the release. */
    stallOpensAfter(count: number): () => void {
      ungatedOpens = count;
      let release = (): void => {};
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        release();
      };
    },
    reset(): void {
      cache.clear();
      freedConnectionIds.length = 0;
      openedConnectionIds.length = 0;
      nextConnectionId = 0;
      ungatedOpens = Number.POSITIVE_INFINITY;
      gate = null;
      openCalls = 0;
    },
  };
});

vi.mock('expo-sqlite', async () => {
  const { createContext, createElement, useContext, useEffect, useRef, useState } = await import('react');
  const SQLiteContext = createContext<unknown>(null);

  // The JS wrapper `openDatabaseAsync` returns: a fresh object per call, all of them
  // bound to one refcounted native connection.
  async function openDatabaseAsync(databaseName: string): Promise<unknown> {
    await sqlite.awaitOpenGate();
    const native = sqlite.openNative(databaseName);
    return {
      native,
      closeAsync: async (): Promise<void> => {
        sqlite.closeNative(native);
      },
    };
  }

  // expo-sqlite's own provider (`build/hooks.js`): the effect opens a connection
  // through the same cache, awaits `onInit`, publishes it, and closes it on teardown.
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
        await onInit(database as never);
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
import { resetDatabaseInitializationForTests } from '../../db/testing';
// Direct, not through ./testing: that barrel must stay clear of expo-sqlite so the
// node-env suites can use it (see the note there). Safe here because this file mocks
// expo-sqlite above.
import { resetConnectionRetentionForTests } from '../../db/connection-retention';

beforeEach(() => {
  resetDatabaseInitializationForTests();
  resetConnectionRetentionForTests();
  setDatabaseHandle(null);
  sqlite.reset();
});

/**
 * Drain the pending task queue. The provider's close is `void db.closeAsync()`, which
 * settles a few microtasks after the unmount that started it.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderProvider(): { unmount: () => void; queryByTestId: (id: string) => unknown } {
  return render(
    <DatabaseProvider>
      <div data-testid="child" />
    </DatabaseProvider>,
  );
}

/**
 * Mount and wait until the provider has PUBLISHED — children rendered, meaning
 * `onInit` resolved and its teardown now has a connection to close. Waiting on the
 * module handle instead would be too early: `initializeDatabase` publishes that while
 * `onInit` is still settling.
 */
async function mountUntilPublished(): Promise<{ unmount: () => void }> {
  const view = renderProvider();
  await waitFor(() => {
    expect(view.queryByTestId('child')).not.toBeNull();
  });
  await settle();
  return view;
}

describe('DatabaseProvider connection retention', () => {
  it('leaves the native connection alive when the provider tears down', async () => {
    const view = await mountUntilPublished();

    view.unmount();
    await settle();

    // Nothing was freed, so no other thread's in-flight `sqlite3_step` /
    // `sqlite3_column_type` / `sqlite3_finalize` can be reading freed memory. Without
    // the retain the provider holds the only reference and this teardown frees it.
    expect(sqlite.freedConnectionIds).toEqual([]);
    expect(sqlite.liveConnections()).toEqual([{ id: 1, refCount: 1 }]);
  });

  it('hands the same live connection back to the next mount', async () => {
    const first = await mountUntilPublished();
    first.unmount();
    await settle();

    const second = await mountUntilPublished();

    // One connection for the whole process: the remount reused connection 1 rather
    // than reopening the file, which is only possible because it was never freed.
    expect(new Set(sqlite.openedConnectionIds)).toEqual(new Set([1]));
    expect(sqlite.freedConnectionIds).toEqual([]);

    second.unmount();
    await settle();
    expect(sqlite.freedConnectionIds).toEqual([]);
  });

  it('does not publish the provider while the reference is still being taken', async () => {
    // The retain's open is stalled where the real one waits on
    // `ensureDatabasePathExistsAsync` — after the call is made, before the constructor
    // that bumps the refcount. The provider's own open (the first) runs normally.
    const releaseRetainOpen = sqlite.stallOpensAfter(1);
    const view = renderProvider();

    // The setup sequence has finished and published the module handle, so `onInit` is
    // waiting on nothing but the retain.
    await waitFor(() => {
      expect(getDatabaseHandle()).not.toBeNull();
    });
    await settle();

    view.unmount();
    await settle();

    // `onInit` had not resolved, so the provider never stored a connection and its
    // teardown had nothing to close. Start the retain and forget it, and this unmount
    // frees the only reference while that open is still in flight — the crash, moved
    // to the first seconds of launch instead of avoided.
    expect(sqlite.freedConnectionIds).toEqual([]);

    releaseRetainOpen();
    await settle();
    expect(sqlite.freedConnectionIds).toEqual([]);
  });
});
