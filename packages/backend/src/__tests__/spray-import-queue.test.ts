import { describe, expect, it } from 'vitest';
import { rankSprayDetectionQueue, type SprayQueueSnapshotJob } from '@boardsesh/db/queries';

const snapshotAt = new Date('2026-10-03T12:00:00.000Z');
function job(id: string, changes: Partial<SprayQueueSnapshotJob> = {}): SprayQueueSnapshotJob {
  return {
    id,
    state: 'created',
    priority: 0,
    blocked: false,
    createdOn: new Date('2026-10-03T11:00:00.000Z'),
    startAfter: new Date('2026-10-03T11:00:00.000Z'),
    ...changes,
  };
}

describe('spray import queue snapshot', () => {
  it('counts active work, then priority and FIFO eligible waiting jobs', () => {
    const positions = rankSprayDetectionQueue(
      [
        job('running', { state: 'active' }),
        job('old'),
        job('new', { createdOn: new Date('2026-10-03T11:01:00.000Z') }),
        job('urgent', { priority: 10 }),
      ],
      snapshotAt,
    );
    expect(positions.get('running')?.queuePosition).toBeNull();
    expect(positions.get('urgent')?.queuePosition).toBe(2);
    expect(positions.get('old')?.queuePosition).toBe(3);
    expect(positions.get('new')?.queuePosition).toBe(4);
  });

  it('excludes blocked, deferred and terminal work and exposes retry backoff', () => {
    const retryAt = new Date('2026-10-03T12:01:00.000Z');
    const positions = rankSprayDetectionQueue(
      [
        job('blocked', { blocked: true, priority: 10 }),
        job('backoff', { state: 'retry', startAfter: retryAt, priority: 10 }),
        job('completed', { state: 'completed', priority: 10 }),
        job('cancelled', { state: 'cancelled', priority: 10 }),
        job('failed', { state: 'failed', priority: 10 }),
        job('waiting'),
      ],
      snapshotAt,
    );
    expect(positions.get('waiting')).toEqual({ queuePosition: 1, retryAt: null });
    expect(positions.get('backoff')).toEqual({ queuePosition: null, retryAt: retryAt.toISOString() });
    expect(positions.get('blocked')).toEqual({ queuePosition: null, retryAt: null });
  });

  it('returns no invented rank for FIFO ties while counting tied work ahead', () => {
    const positions = rankSprayDetectionQueue(
      [job('first-tie'), job('second-tie'), job('later', { createdOn: new Date('2026-10-03T11:01:00.000Z') })],
      snapshotAt,
    );
    expect(positions.get('first-tie')?.queuePosition).toBeNull();
    expect(positions.get('second-tie')?.queuePosition).toBeNull();
    expect(positions.get('later')?.queuePosition).toBe(3);
  });

  it('advances a position as active work finishes and deferred retries become eligible', () => {
    const waitingJob = job('waiting', { createdOn: new Date('2026-10-03T11:01:00.000Z') });
    const retryJob = job('retry', { state: 'retry', startAfter: new Date('2026-10-03T12:01:00.000Z') });
    const before = rankSprayDetectionQueue([job('active', { state: 'active' }), waitingJob, retryJob], snapshotAt);
    const after = rankSprayDetectionQueue([waitingJob, retryJob], new Date('2026-10-03T12:01:00.000Z'));
    expect(before.get('waiting')).toEqual({ queuePosition: 2, retryAt: null });
    expect(after.get('retry')).toEqual({ queuePosition: 1, retryAt: null });
    expect(after.get('waiting')).toEqual({ queuePosition: 2, retryAt: null });
  });
});
