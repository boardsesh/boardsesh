// Issue #4315: the three offline-write losses the drainer's own telemetry can
// never see — a backlog that predates the per-mutation events, sign-out
// deleting the whole outbox, and an enqueue swallowed at INSERT time.
//
// Issue #4331 adds the launch recovery sweep that puts back the dead letters a
// lost local write lock manufactured, plus the revived-enqueue counterpart to
// the suppressed report.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getOutboxSummaryMock = vi.hoisted(() => vi.fn());
const getDeadLettersMock = vi.hoisted(() => vi.fn());
const retryDeadLetterMock = vi.hoisted(() => vi.fn());
vi.mock('@boardsesh/offline-sync', async () => {
  const actual = await vi.importActual<typeof import('@boardsesh/offline-sync')>('@boardsesh/offline-sync');
  return {
    ...actual,
    getOutboxSummary: getOutboxSummaryMock,
    getDeadLetters: getDeadLettersMock,
    retryDeadLetter: retryDeadLetterMock,
  };
});

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/analytics', () => ({ track: trackMock }));

const reportHandledErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/error-reporting', () => ({ reportHandledError: reportHandledErrorMock }));

import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { SqlExecutor } from '@boardsesh/offline-sync';
import {
  recoverAndReportOutboxOnce,
  reportOutboxDiscardedOnSignOut,
  reportEnqueueRevived,
  reportEnqueueSuppressed,
  __resetOutboxTelemetryForTests,
} from '../outbox-telemetry';

const db = {} as SqlExecutor;

const emptyOutbox = { pendingCount: 0, deadLetterCount: 0, oldestPendingAt: null, oldestDeadLetterAt: null };

// The lock message Android actually emits, minus the raw control byte (never put
// one in a source file — see lock-errors.ts).
const LOCK_ERROR =
  "Call to function 'NativeStatement.finalizeAsync' has been rejected. → Caused by: database is locked";

function deadLetterRow(id: number, lastError: string | null) {
  return {
    id,
    table_name: 'user_favorites',
    operation: 'create',
    payload: '{}',
    idempotency_key: `add:user_favorites:kilter:climb-${id}:40`,
    created_at: '2026-07-20 00:00:00',
    retry_count: 0,
    max_retries: 10,
    last_error: lastError,
    status: 'dead_letter',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetOutboxTelemetryForTests();
  getOutboxSummaryMock.mockResolvedValue(emptyOutbox);
  getDeadLettersMock.mockResolvedValue([]);
  retryDeadLetterMock.mockResolvedValue(undefined);
});

describe('recoverAndReportOutboxOnce', () => {
  it('emits once with counts and ages when work is queued', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T00:00:00Z'));
    getOutboxSummaryMock.mockResolvedValue({
      pendingCount: 4,
      deadLetterCount: 1,
      oldestPendingAt: '2026-08-10 00:00:00',
      oldestDeadLetterAt: '2026-08-02 00:00:00',
    });

    await recoverAndReportOutboxOnce(db);

    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineOutboxBacklogDetected, {
      pendingCount: 4,
      deadLetterCount: 1,
      oldestPendingAgeDays: 2,
      oldestDeadLetterAgeDays: 10,
      deadLettersRevived: 0,
    });
    vi.useRealTimers();
  });

  it('stays silent on an empty outbox', async () => {
    await recoverAndReportOutboxOnce(db);
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('does not fire twice when the bridge effect re-runs', async () => {
    getOutboxSummaryMock.mockResolvedValue({ ...emptyOutbox, deadLetterCount: 2 });

    await recoverAndReportOutboxOnce(db);
    await recoverAndReportOutboxOnce(db);

    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(getOutboxSummaryMock).toHaveBeenCalledTimes(1);
  });

  it('swallows a failed read rather than taking the sync bridge down', async () => {
    getOutboxSummaryMock.mockRejectedValue(new Error('database is locked'));
    await expect(recoverAndReportOutboxOnce(db)).resolves.toBeUndefined();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('skips the dead-letter read entirely when nothing dead-lettered', async () => {
    getOutboxSummaryMock.mockResolvedValue({ ...emptyOutbox, pendingCount: 3 });

    await recoverAndReportOutboxOnce(db);

    expect(getDeadLettersMock).not.toHaveBeenCalled();
    expect(trackMock).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineOutboxBacklogDetected,
      expect.objectContaining({ deadLettersRevived: 0 }),
    );
  });
});

// The recovery half of the fix: devices are still carrying rows a lost write
// lock dead-lettered, some a month old, and only the ones a LOCAL lock created
// may be re-sent — those were accepted by the server before the local DELETE
// failed.
describe('recoverAndReportOutboxOnce — lock-caused dead letters', () => {
  beforeEach(() => {
    getOutboxSummaryMock.mockResolvedValue({ ...emptyOutbox, deadLetterCount: 3 });
  });

  it('puts back every dead letter whose last error was a local lock', async () => {
    getDeadLettersMock.mockResolvedValue([deadLetterRow(1, LOCK_ERROR), deadLetterRow(2, LOCK_ERROR)]);

    await recoverAndReportOutboxOnce(db);

    expect(retryDeadLetterMock).toHaveBeenCalledTimes(2);
    expect(retryDeadLetterMock).toHaveBeenCalledWith(db, 1);
    expect(retryDeadLetterMock).toHaveBeenCalledWith(db, 2);
    expect(trackMock).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineOutboxBacklogDetected,
      expect.objectContaining({ deadLetterCount: 3, deadLettersRevived: 2 }),
    );
  });

  it.each([
    ['a server rejection', 'Response not successful: Received status code 400'],
    ['a validation failure', 'climb not found'],
    ['a broken database', 'database or disk is full'],
    ['no recorded error at all', null],
  ])('leaves a dead letter from %s alone', async (_label, lastError) => {
    getDeadLettersMock.mockResolvedValue([deadLetterRow(7, lastError)]);

    await recoverAndReportOutboxOnce(db);

    expect(retryDeadLetterMock).not.toHaveBeenCalled();
    expect(trackMock).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineOutboxBacklogDetected,
      expect.objectContaining({ deadLettersRevived: 0 }),
    );
  });

  it('sweeps at most once even when the bridge effect re-runs', async () => {
    getDeadLettersMock.mockResolvedValue([deadLetterRow(1, LOCK_ERROR)]);

    await recoverAndReportOutboxOnce(db);
    await recoverAndReportOutboxOnce(db);

    expect(getDeadLettersMock).toHaveBeenCalledTimes(1);
    expect(retryDeadLetterMock).toHaveBeenCalledTimes(1);
  });

  it('swallows a failed revive rather than taking the sync bridge down', async () => {
    getDeadLettersMock.mockResolvedValue([deadLetterRow(1, LOCK_ERROR)]);
    retryDeadLetterMock.mockRejectedValue(new Error('database is locked'));

    await expect(recoverAndReportOutboxOnce(db)).resolves.toBeUndefined();
  });

  // The ceiling is a guard against a pathological outbox, not a real limit —
  // the fleet's worst device carries 3 dead letters. Whatever it skips is picked
  // up by the next launch.
  it('asks the query for at most a launch ceiling of rows', async () => {
    // The LIMIT rides the SELECT, so a pathological outbox is never read into
    // memory just to be trimmed afterwards.
    getDeadLettersMock.mockResolvedValue(
      Array.from({ length: 50 }, (_unused, index) => deadLetterRow(index + 1, LOCK_ERROR)),
    );

    await recoverAndReportOutboxOnce(db);

    expect(getDeadLettersMock).toHaveBeenCalledWith(db, 50);
    expect(retryDeadLetterMock).toHaveBeenCalledTimes(50);
    expect(trackMock).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineOutboxBacklogDetected,
      expect.objectContaining({ deadLettersRevived: 50 }),
    );
  });

  // The sweep runs once per runtime, so one contended UPDATE aborting the loop
  // would strand every row behind it until the next launch.
  it('keeps sweeping the rows behind one that could not be revived', async () => {
    getDeadLettersMock.mockResolvedValue([
      deadLetterRow(1, LOCK_ERROR),
      deadLetterRow(2, LOCK_ERROR),
      deadLetterRow(3, LOCK_ERROR),
    ]);
    retryDeadLetterMock.mockRejectedValueOnce(new Error('database is locked')).mockResolvedValue(undefined);

    await recoverAndReportOutboxOnce(db);

    expect(retryDeadLetterMock).toHaveBeenCalledTimes(3);
    expect(trackMock).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineOutboxBacklogDetected,
      // Only the two that actually went back in the queue are counted.
      expect.objectContaining({ deadLettersRevived: 2 }),
    );
  });
});

describe('reportOutboxDiscardedOnSignOut', () => {
  it('reports what the sign-out wipe is about to delete', async () => {
    getOutboxSummaryMock.mockResolvedValue({ ...emptyOutbox, pendingCount: 1, deadLetterCount: 3 });

    await reportOutboxDiscardedOnSignOut(db);

    expect(trackMock).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineOutboxDiscardedOnSignOut,
      expect.objectContaining({ pendingCount: 1, deadLetterCount: 3 }),
    );
  });

  it('is not once-per-launch — every sign-out reports its own loss', async () => {
    getOutboxSummaryMock.mockResolvedValue({ ...emptyOutbox, deadLetterCount: 1 });

    await reportOutboxDiscardedOnSignOut(db);
    await reportOutboxDiscardedOnSignOut(db);

    expect(trackMock).toHaveBeenCalledTimes(2);
  });

  it('never throws, so a wedged database cannot block sign-out', async () => {
    getOutboxSummaryMock.mockRejectedValue(new Error('database is locked'));
    await expect(reportOutboxDiscardedOnSignOut(db)).resolves.toBeUndefined();
  });
});

describe('reportEnqueueRevived', () => {
  it('counts the recovery without raising a Sentry error', () => {
    reportEnqueueRevived('user_favorites', 'create');

    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineMutationRevived, {
      tableName: 'user_favorites',
      operation: 'create',
    });
    expect(reportHandledErrorMock).not.toHaveBeenCalled();
  });
});

describe('reportEnqueueSuppressed', () => {
  it('reports a suppression against a dead-lettered row', () => {
    reportEnqueueSuppressed('user_favorites', 'create', 'dead_letter');

    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineMutationEnqueueSuppressed, {
      tableName: 'user_favorites',
      operation: 'create',
      existingStatus: 'dead_letter',
    });
    expect(reportHandledErrorMock).toHaveBeenCalledTimes(1);
  });

  // A duplicate against a live pending row is correct dedup (a double-tapped
  // favorite while offline). Reporting it would bury the real signal.
  it.each(['pending', null])('stays silent for existingStatus %p', (existingStatus) => {
    reportEnqueueSuppressed('user_favorites', 'create', existingStatus);

    expect(trackMock).not.toHaveBeenCalled();
    expect(reportHandledErrorMock).not.toHaveBeenCalled();
  });
});
