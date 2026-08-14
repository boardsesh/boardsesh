// The favorites/follows blind spot closes here (issue #4315): before this event,
// a favorite whose local write lost the lock rejected with no Sentry report and
// no analytics at all. These assertions pin what the one event says.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/analytics', () => ({ track: trackMock }));

const isOnlineMock = vi.hoisted(() => vi.fn(() => true));
vi.mock('../offline-sync-adapter', () => ({ isOnline: isOnlineMock }));

import { SHARED_EVENTS } from '@boardsesh/analytics';
import { localWriteRetryOptions } from '../local-write-telemetry';

const LOCK_ERROR = new Error('Error code 5: database is locked');
const DISK_ERROR = new Error('database or disk is full');

beforeEach(() => {
  vi.clearAllMocks();
  isOnlineMock.mockReturnValue(true);
});

describe('localWriteRetryOptions', () => {
  it('reports a recovered write with its table, operation and timings', () => {
    localWriteRetryOptions('boardsesh_ticks', 'create').onSettled?.({
      attempts: 2,
      error: LOCK_ERROR,
      recovered: true,
      elapsedMs: 5150,
    });

    expect(trackMock).toHaveBeenCalledWith(SHARED_EVENTS.OfflineLocalWriteAttemptFailed, {
      tableName: 'boardsesh_ticks',
      operation: 'create',
      attempts: 2,
      elapsedMs: 5150,
      outcome: 'recovered',
      isLockError: true,
      wasOffline: false,
    });
  });

  it('reports an exhausted lock failure', () => {
    localWriteRetryOptions('user_favorites', 'delete').onSettled?.({
      attempts: 2,
      error: LOCK_ERROR,
      recovered: false,
      elapsedMs: 6700,
    });

    expect(trackMock).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineLocalWriteAttemptFailed,
      expect.objectContaining({
        tableName: 'user_favorites',
        operation: 'delete',
        outcome: 'exhausted',
        isLockError: true,
      }),
    );
  });

  // attempts: 1 + exhausted is how a non-retryable error reads in the funnel.
  it('marks a non-lock error as such and shows it was never retried', () => {
    localWriteRetryOptions('user_follows', 'create').onSettled?.({
      attempts: 1,
      error: DISK_ERROR,
      recovered: false,
      elapsedMs: 12,
    });

    expect(trackMock).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineLocalWriteAttemptFailed,
      expect.objectContaining({ attempts: 1, isLockError: false, outcome: 'exhausted' }),
    );
  });

  it('follows the connectivity reading for wasOffline', () => {
    isOnlineMock.mockReturnValue(false);

    localWriteRetryOptions('boardsesh_ticks', 'create').onSettled?.({
      attempts: 2,
      error: LOCK_ERROR,
      recovered: false,
      elapsedMs: 8800,
    });

    expect(trackMock).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineLocalWriteAttemptFailed,
      expect.objectContaining({ wasOffline: true }),
    );
  });

  it('swallows a throwing analytics client so a saved write stays saved', () => {
    trackMock.mockImplementation(() => {
      throw new Error('posthog exploded');
    });

    expect(() =>
      localWriteRetryOptions('boardsesh_ticks', 'create').onSettled?.({
        attempts: 2,
        error: LOCK_ERROR,
        recovered: true,
        elapsedMs: 1,
      }),
    ).not.toThrow();
  });
});
