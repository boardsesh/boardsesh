import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/shared-schema';
import type { QueueState } from '../services/room-manager/types';
import { VersionConflictError } from '../services/room-manager/types';

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), publish: vi.fn() }));
vi.mock('../services/room-manager', async () => ({
  VersionConflictError: (await import('../services/room-manager/types')).VersionConflictError,
  roomManager: { getQueueState: mocks.read, updateQueueState: mocks.write },
}));
vi.mock('../pubsub/index', () => ({ pubsub: { publishQueueEvent: mocks.publish } }));
import { mirrorSessionClimb, MirrorTargetChangedError } from '../services/queue-mirror';

function snapshot(uuid = 'slot-1', mirrored = false): QueueState {
  const item = { uuid, climb: { uuid: 'climb-1', mirrored } } as unknown as ClimbQueueItem;
  return {
    queue: [item],
    currentClimbQueueItem: item,
    sequence: 4,
    version: 4,
    stateHash: 'before',
    stateHashOrdered: 'before-v2',
  };
}

describe('confirmed session mirroring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.read.mockResolvedValue(snapshot());
    mocks.write.mockResolvedValue({ sequence: 5, stateHash: 'after', stateHashOrdered: 'after-v2' });
  });

  it('updates the current slot and queue together and broadcasts the absolute orientation', async () => {
    const result = await mirrorSessionClimb('session', true, 'slot-1');
    expect(mocks.write).toHaveBeenCalledWith('session', [result?.item], result?.item, 4);
    expect(result?.item.climb.mirrored).toBe(true);
    expect(mocks.publish).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({ __typename: 'ClimbMirrored', uuid: 'slot-1', mirrored: true, sequence: 5 }),
    );
  });

  it('does not publish or advance sequence when the requested orientation already matches', async () => {
    mocks.read.mockResolvedValue(snapshot('slot-1', true));
    const result = await mirrorSessionClimb('session', true, 'slot-1');
    expect(result?.event.sequence).toBe(4);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('rechecks the target after a version conflict instead of mirroring the next climb', async () => {
    mocks.read.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot('slot-2'));
    mocks.write.mockRejectedValueOnce(new VersionConflictError('session', 4));
    await expect(mirrorSessionClimb('session', true, 'slot-1')).rejects.toBeInstanceOf(MirrorTargetChangedError);
    expect(mocks.write).toHaveBeenCalledTimes(1);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('preserves concurrent queue additions during retry', async () => {
    const concurrent = snapshot();
    concurrent.queue.push({ uuid: 'slot-2', climb: { uuid: 'other' } } as unknown as ClimbQueueItem);
    concurrent.version = 5;
    mocks.read.mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(concurrent);
    mocks.write
      .mockRejectedValueOnce(new VersionConflictError('session', 4))
      .mockResolvedValueOnce({ sequence: 6, stateHash: 'after', stateHashOrdered: 'after-v2' });
    await mirrorSessionClimb('session', true, 'slot-1');
    expect(mocks.write.mock.calls[1][1]).toHaveLength(2);
    expect(mocks.write.mock.calls[1][3]).toBe(5);
  });
});
