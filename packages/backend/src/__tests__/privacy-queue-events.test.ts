import { describe, expect, it, vi } from 'vite-plus/test';
import type { ClimbQueueItem, QueueEvent } from '@boardsesh/shared-schema';
vi.hoisted(() => vi.resetModules());
const projection = vi.hoisted(() => ({
  redactQueueItem: vi.fn(async (item: ClimbQueueItem) => ({
    ...item,
    addedBy: undefined,
    addedByUser: undefined,
    tickedBy: [],
    climb: { ...item.climb, name: '', frames: '', setter_username: '' },
  })),
}));
vi.mock('../services/board-session-privacy', () => projection);
const { redactQueueEvent } = await import('../services/privacy-queue-events');

const item: ClimbQueueItem = {
  uuid: 'queue-1',
  addedBy: 'private-user',
  addedByUser: { id: 'private-user', username: 'Private name' },
  tickedBy: ['private-user'],
  climb: {
    uuid: 'private-climb',
    name: 'Private name',
    frames: 'private-holds',
    setter_username: 'Private setter',
    angle: 40,
    ascensionist_count: 1,
    difficulty: 'V4',
    quality_average: '3',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
  },
};

describe('queue replay projection', () => {
  it('redacts buffered additions exactly like live additions while preserving sequence and hashes', async () => {
    const event: QueueEvent = { __typename: 'QueueItemAdded', sequence: 42, stateHash: 'same-hash', item };
    const projected = await redactQueueEvent(event, 'viewer', 'session-1');
    expect(projected).toMatchObject({
      sequence: 42,
      stateHash: 'same-hash',
      item: { addedBy: undefined, tickedBy: [], climb: { uuid: 'private-climb', name: '', frames: '' } },
    });
    expect(projection.redactQueueItem).toHaveBeenCalledWith(item, 'viewer', 'session-1');
    expect(event.item.addedBy).toBe('private-user');
  });
  it('projects full snapshots and removes unattributed frame payloads', async () => {
    const full = await redactQueueEvent(
      {
        __typename: 'FullSync',
        sequence: 42,
        state: { sequence: 42, stateHash: 'same-hash', queue: [item], currentClimbQueueItem: item },
      },
      'viewer',
      'session-1',
    );
    expect(full).toMatchObject({
      state: { queue: [{ addedBy: undefined }], currentClimbQueueItem: { addedBy: undefined } },
    });
    expect(
      await redactQueueEvent(
        {
          __typename: 'CurrentClimbChanged',
          sequence: 43,
          stateHash: 'hash',
          item: null,
          frames: 'unattributed-holds',
          clientId: null,
          correlationId: null,
        },
        'viewer',
        'session-1',
      ),
    ).toMatchObject({ sequence: 43, frames: null });
  });
});
