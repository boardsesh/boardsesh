// Issue #4315: the three offline-write losses the drainer's own telemetry can
// never see — a backlog that predates the per-mutation events, sign-out
// deleting the whole outbox, and an enqueue swallowed at INSERT time.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getOutboxSummaryMock = vi.hoisted(() => vi.fn());
vi.mock('@boardsesh/offline-sync', async () => {
  const actual = await vi.importActual<typeof import('@boardsesh/offline-sync')>('@boardsesh/offline-sync');
  return { ...actual, getOutboxSummary: getOutboxSummaryMock };
});

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/analytics', () => ({ track: trackMock }));

const reportHandledErrorMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/error-reporting', () => ({ reportHandledError: reportHandledErrorMock }));

import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { SqlExecutor } from '@boardsesh/offline-sync';
import {
  reportOutboxBacklogOnce,
  reportOutboxDiscardedOnSignOut,
  reportEnqueueSuppressed,
  __resetOutboxTelemetryForTests,
} from '../outbox-telemetry';

const db = {} as SqlExecutor;

const emptyOutbox = { pendingCount: 0, deadLetterCount: 0, oldestPendingAt: null, oldestDeadLetterAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  __resetOutboxTelemetryForTests();
  getOutboxSummaryMock.mockResolvedValue(emptyOutbox);
});

describe('reportOutboxBacklogOnce', () => {
  it('emits once with counts and ages when work is queued', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-12T00:00:00Z'));
    getOutboxSummaryMock.mockResolvedValue({
      pendingCount: 4,
      deadLetterCount: 1,
      oldestPendingAt: '2026-08-10 00:00:00',
      oldestDeadLetterAt: '2026-08-02 00:00:00',
    });

    await reportOutboxBacklogOnce(db);

    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineOutboxBacklogDetected, {
      pendingCount: 4,
      deadLetterCount: 1,
      oldestPendingAgeDays: 2,
      oldestDeadLetterAgeDays: 10,
    });
    vi.useRealTimers();
  });

  it('stays silent on an empty outbox', async () => {
    await reportOutboxBacklogOnce(db);
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('does not fire twice when the bridge effect re-runs', async () => {
    getOutboxSummaryMock.mockResolvedValue({ ...emptyOutbox, deadLetterCount: 2 });

    await reportOutboxBacklogOnce(db);
    await reportOutboxBacklogOnce(db);

    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(getOutboxSummaryMock).toHaveBeenCalledTimes(1);
  });

  it('swallows a failed read rather than taking the sync bridge down', async () => {
    getOutboxSummaryMock.mockRejectedValue(new Error('database is locked'));
    await expect(reportOutboxBacklogOnce(db)).resolves.toBeUndefined();
    expect(trackMock).not.toHaveBeenCalled();
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
