import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captureToSentryMock = vi.hoisted(() => vi.fn());
const captureToObserveMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
const markStartupMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/sentry', () => ({
  addBreadcrumbToSentry: vi.fn(),
  captureToSentry: captureToSentryMock,
}));
vi.mock('../../lib/observe-runtime', () => ({ captureToObserve: captureToObserveMock }));
vi.mock('../../lib/analytics', () => ({ track: trackMock }));
vi.mock('../../lib/profiling/startup-profile', () => ({ markStartup: markStartupMock }));

import type { SQLiteDatabase } from 'expo-sqlite';
import { runMigrations } from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { reportError } from '../../lib/error-reporting';
import {
  getDatabaseHandle,
  INIT_LOCK_RETRY_DELAYS_MS,
  INIT_RETRY_DELAYS_MS,
  initializeDatabase,
  registerReplacementOpener,
  resetDeadHandleRecoveryForTests,
  setDatabaseHandle,
} from '../connection';
import { __resetSchemaReadyForTests, isSchemaReady } from '../schema-ready';
import { resetDatabaseInitializationForTests, resetDatabasePinsForTests } from '../testing';

const CLOSED_HANDLE_MESSAGE = 'Access to closed resource';
const LOCK_ERROR_MESSAGE = "Calling the 'execAsync' function has failed → Error code 5: database is locked";
const WHOLE_RETRY_LADDER_MS = [...INIT_RETRY_DELAYS_MS, ...INIT_LOCK_RETRY_DELAYS_MS].reduce(
  (total, delay) => total + delay,
  1_000,
);

let backingDatabase: TestSqliteDb & SQLiteDatabase;
let holdJournalModeReadback = false;
let journalModeReadbackHeld = false;
let journalModeReadbackGate: Promise<void>;
let releaseJournalModeReadback: () => void;
let journalModeReadbackStarted: Promise<void>;
let signalJournalModeReadbackStarted: () => void;

function createDatabase(options: { failure?: Error; onFailure?: () => void } = {}): SQLiteDatabase {
  return {
    execAsync: async (source: string): Promise<void> => {
      if (options.failure && /pending_mutations/i.test(source)) {
        options.onFailure?.();
        throw options.failure;
      }
      await backingDatabase.execAsync(source);
    },
    getFirstAsync: async <T>(source: string, ...params: unknown[]): Promise<T | null> => {
      if (
        holdJournalModeReadback &&
        !journalModeReadbackHeld &&
        source.trim().toUpperCase() === 'PRAGMA JOURNAL_MODE'
      ) {
        journalModeReadbackHeld = true;
        signalJournalModeReadbackStarted();
        await journalModeReadbackGate;
      }
      return backingDatabase.getFirstAsync<T>(source, ...(params as never[]));
    },
    getAllAsync: <T>(source: string, ...params: unknown[]): Promise<T[]> =>
      backingDatabase.getAllAsync<T>(source, ...(params as never[])),
    runAsync: (source: string, ...params: unknown[]) => backingDatabase.runAsync(source, ...(params as never[])),
    withExclusiveTransactionAsync: (task: (transaction: unknown) => Promise<void>) =>
      backingDatabase.withExclusiveTransactionAsync(task as never),
  } as unknown as SQLiteDatabase;
}

function createRemountingConnection(error: Error): SQLiteDatabase {
  return createDatabase({
    failure: error,
    onFailure: () => {
      void initializeDatabase(createRemountingConnection(error));
    },
  });
}

beforeEach(async () => {
  vi.useRealTimers();
  resetDeadHandleRecoveryForTests();
  resetDatabaseInitializationForTests();
  resetDatabasePinsForTests();
  setDatabaseHandle(null);
  __resetSchemaReadyForTests();
  captureToSentryMock.mockReset();
  captureToObserveMock.mockReset();
  trackMock.mockReset();
  markStartupMock.mockReset();

  backingDatabase = createTestDatabase() as unknown as TestSqliteDb & SQLiteDatabase;
  await runMigrations(backingDatabase);

  holdJournalModeReadback = false;
  journalModeReadbackHeld = false;
  journalModeReadbackGate = new Promise<void>((resolve) => {
    releaseJournalModeReadback = resolve;
  });
  journalModeReadbackStarted = new Promise<void>((resolve) => {
    signalJournalModeReadbackStarted = resolve;
  });
});

afterEach(() => {
  vi.useRealTimers();
  setDatabaseHandle(null);
  resetDatabaseInitializationForTests();
  resetDeadHandleRecoveryForTests();
  resetDatabasePinsForTests();
});

describe('SQLite initialization through the real error-reporting funnel', () => {
  it('keeps a healthy remount when a superseded closed-handle report resumes after journal read-back', async () => {
    holdJournalModeReadback = true;
    const replacementOpener = vi.fn(async () => createDatabase());
    registerReplacementOpener(replacementOpener);

    vi.useFakeTimers();
    await initializeDatabase(createRemountingConnection(new Error(CLOSED_HANDLE_MESSAGE)));
    await vi.advanceTimersByTimeAsync(WHOLE_RETRY_LADDER_MS);
    await journalModeReadbackStarted;

    const healthyRemount = createDatabase();
    await initializeDatabase(healthyRemount);
    expect(getDatabaseHandle()).toBe(healthyRemount);
    expect(isSchemaReady()).toBe(true);

    vi.useRealTimers();
    releaseJournalModeReadback();
    await vi.waitFor(() =>
      expect(
        captureToSentryMock.mock.calls.some(
          ([, reportContext]) => reportContext?.tags?.kind === 'sqlite-init-superseded',
        ),
      ).toBe(true),
    );

    const supersededReport = captureToSentryMock.mock.calls.find(
      ([, reportContext]) => reportContext?.tags?.kind === 'sqlite-init-superseded',
    );
    expect(supersededReport?.[0]).toMatchObject({
      message: 'SQLite initialization failed on a superseded closed connection',
    });
    expect(supersededReport?.[1]).toMatchObject({
      tags: { source: 'offline-sync', kind: 'sqlite-init-superseded', superseded: 'true' },
      extra: { retryable: false, failureMessage: CLOSED_HANDLE_MESSAGE },
    });
    expect(
      captureToSentryMock.mock.calls.some(([, reportContext]) => reportContext?.tags?.kind === 'sqlite-dead-handle'),
    ).toBe(false);
    expect(
      captureToSentryMock.mock.calls.some(
        ([reportedError, reportContext]) =>
          reportedError?.message === CLOSED_HANDLE_MESSAGE && reportContext?.tags?.kind === 'sqlite-init',
      ),
    ).toBe(false);
    expect(captureToObserveMock).toHaveBeenCalled();
    expect(replacementOpener).not.toHaveBeenCalled();
    expect(getDatabaseHandle()).toBe(healthyRemount);
    expect(isSchemaReady()).toBe(true);
  });

  it('keeps genuinely exhausted SQLITE_BUSY telemetry in the sqlite-init aggregate', async () => {
    const replacementOpener = vi.fn(async () => createDatabase());
    registerReplacementOpener(replacementOpener);

    vi.useFakeTimers();
    await initializeDatabase(createRemountingConnection(new Error(LOCK_ERROR_MESSAGE)));
    await vi.advanceTimersByTimeAsync(WHOLE_RETRY_LADDER_MS);
    await vi.waitFor(() => expect(captureToSentryMock).toHaveBeenCalled());

    expect(captureToSentryMock).toHaveBeenCalledTimes(1);
    const [reportedError, reportContext] = captureToSentryMock.mock.calls[0];
    expect(reportedError).toMatchObject({ message: LOCK_ERROR_MESSAGE });
    expect(reportContext).toMatchObject({
      tags: { source: 'offline-sync', kind: 'sqlite-init', sqlite_code: 5, superseded: 'true' },
      extra: { retryable: true },
    });
    expect(replacementOpener).not.toHaveBeenCalled();
  });

  it('still recovers a closed handle that is the current database', async () => {
    const healthyReplacement = createDatabase();
    const replacementOpener = vi.fn(async () => healthyReplacement);
    registerReplacementOpener(replacementOpener);
    const deadHandle = createDatabase();
    setDatabaseHandle(deadHandle);

    reportError(new Error(CLOSED_HANDLE_MESSAGE));

    expect(getDatabaseHandle()).toBeNull();
    expect(isSchemaReady()).toBe(false);
    await vi.waitFor(() => expect(getDatabaseHandle()).toBe(healthyReplacement));
    expect(replacementOpener).toHaveBeenCalledTimes(1);
    expect(isSchemaReady()).toBe(true);
  });
});
