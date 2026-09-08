// @vitest-environment jsdom
// #5292: SQLiteProvider's effect teardown closes its connection, and nothing told the
// module-level handle about it — `getDatabaseHandle()` went on serving a closed
// connection to the sync scheduler and mutation drainer, neither of which is inside
// React and neither of which can see a remount. Driven through the provider's own
// lifecycle rather than by calling the retraction directly, because what has to hold
// is an ordering: the handle is gone by the time the close lands.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

vi.mock('../../lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../lib/profiling/startup-profile', () => ({ markStartup: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }));

// The real engine runs SQL, and its node:sqlite test adapter cannot be bundled into
// this file's jsdom environment. Everything about the DDL is covered against the REAL
// schema in db/__tests__/connection.test.ts; what this suite needs from the setup
// sequence is only that it succeeds, so the handle gets published and the teardown has
// something to retract.
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

// Everything the fake provider below has to hand back to the test. vi.hoisted because
// the mock factory is hoisted above this file's imports, so it cannot close over an
// ordinary top-level const.
const sqlite = vi.hoisted(() => ({
  // A distinct object per mount, exactly like `openDatabaseAsync` — the identity is
  // what the retraction checks.
  openConnection: (): unknown => ({ connection: 'unset' }),
  // What `getDatabaseHandle()` returned at the moment the provider closed a
  // connection. Null means the retraction won the race, which is the point.
  closes: [] as { database: unknown; handleAtClose: unknown }[],
  readHandle: (): unknown => null,
}));

// Stands in for expo-sqlite's own provider (`build/hooks.js`): the effect opens a
// connection, awaits `onInit`, publishes it through context, and closes it on
// teardown. That open → onInit → close shape is the bug.
vi.mock('expo-sqlite', async () => {
  const { createContext, createElement, useContext, useEffect, useRef, useState } = await import('react');
  const SQLiteContext = createContext<unknown>(null);

  function SQLiteProvider({ children, onInit }: { children?: unknown; onInit: (db: never) => Promise<void> }) {
    const databaseRef = useRef<unknown>(null);
    const [, setOpened] = useState(false);

    useEffect(() => {
      async function setup(): Promise<void> {
        const database = sqlite.openConnection();
        await onInit(database as never);
        databaseRef.current = database;
        setOpened(true);
      }
      void setup();
      return () => {
        const database = databaseRef.current;
        databaseRef.current = null;
        setOpened(false);
        if (database === null) return;
        // expo-sqlite's teardown is `async function teardown(db) { await
        // db.closeAsync(); }` — started from the cleanup, settled a microtask later.
        // Recording the handle at THAT point is the assertion that matters: whatever
        // order React runs the cleanups in, no reader may still be holding this
        // connection once it is actually closed.
        void Promise.resolve().then(() => {
          sqlite.closes.push({ database, handleAtClose: sqlite.readHandle() });
        });
      };
    }, [onInit]);

    if (databaseRef.current === null) return null;
    return createElement(SQLiteContext.Provider, { value: databaseRef.current }, children as never);
  }

  return { SQLiteProvider, useSQLiteContext: () => useContext(SQLiteContext) };
});

import { DatabaseProvider } from '../database-provider';
import { getDatabaseHandle, setDatabaseHandle } from '../../db/connection';
import { isSchemaReady } from '../../db/schema-ready';
import { resetDatabaseInitializationForTests } from '../../db/testing';

beforeEach(() => {
  resetDatabaseInitializationForTests();
  setDatabaseHandle(null);
  sqlite.closes.length = 0;
  sqlite.readHandle = () => getDatabaseHandle();
  let opened = 0;
  sqlite.openConnection = () => {
    opened += 1;
    return { connection: opened };
  };
});

describe('DatabaseProvider', () => {
  it('retracts the handle before the connection is closed', async () => {
    const view = render(
      <DatabaseProvider>
        <div data-testid="child" />
      </DatabaseProvider>,
    );

    await waitFor(() => {
      expect(getDatabaseHandle()).not.toBeNull();
    });
    const published = getDatabaseHandle();

    view.unmount();

    expect(getDatabaseHandle()).toBeNull();
    expect(isSchemaReady()).toBe(false);
    // The provider really did close the connection it had published, and by the time
    // that close landed the handle no longer pointed at it. Without the retraction a
    // reader here gets a connection that throws `Access to closed resource`.
    await waitFor(() => {
      expect(sqlite.closes).toEqual([{ database: published, handleAtClose: null }]);
    });
  });
});
