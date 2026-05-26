import { describe, it, expect } from 'vite-plus/test';
import type { Climb, ClimbQueueItem, SubscriptionQueueEvent } from '@boardsesh/shared-schema';
import { toSyncQueueEvent } from '../use-queue-event-subscription';

const climb: Climb = {
  uuid: 'climb-1',
  setter_username: 'setter',
  name: 'Test',
  frames: '',
  angle: 40,
  ascensionist_count: 0,
  difficulty: '7',
  quality_average: '3',
  stars: 3,
  difficulty_error: '',
  benchmark_difficulty: null,
};

const item: ClimbQueueItem = { uuid: 'q-1', climb };

describe('toSyncQueueEvent', () => {
  it('maps FullSync, forwarding queue and currentClimbQueueItem', () => {
    const event: SubscriptionQueueEvent = {
      __typename: 'FullSync',
      sequence: 1,
      state: { sequence: 1, stateHash: 'h', queue: [item], currentClimbQueueItem: item },
    };
    expect(toSyncQueueEvent(event)).toEqual({
      __typename: 'FullSync',
      state: { queue: [item], currentClimbQueueItem: item },
    });
  });

  it('maps FullSync with a null currentClimbQueueItem', () => {
    const event: SubscriptionQueueEvent = {
      __typename: 'FullSync',
      sequence: 1,
      state: { sequence: 1, stateHash: 'h', queue: [], currentClimbQueueItem: null },
    };
    const result = toSyncQueueEvent(event);
    expect(result.__typename).toBe('FullSync');
    if (result.__typename === 'FullSync') {
      expect(result.state.currentClimbQueueItem).toBeNull();
    }
  });

  it('maps QueueItemAdded, preserving the addedItem alias and position', () => {
    const event: SubscriptionQueueEvent = {
      __typename: 'QueueItemAdded',
      sequence: 2,
      stateHash: 'h',
      addedItem: item,
      position: 3,
    };
    expect(toSyncQueueEvent(event)).toEqual({
      __typename: 'QueueItemAdded',
      addedItem: item,
      position: 3,
    });
  });

  it('maps QueueItemRemoved, forwarding uuid', () => {
    const event: SubscriptionQueueEvent = {
      __typename: 'QueueItemRemoved',
      sequence: 3,
      stateHash: 'h',
      uuid: 'q-9',
    };
    expect(toSyncQueueEvent(event)).toEqual({ __typename: 'QueueItemRemoved', uuid: 'q-9' });
  });

  it('maps QueueReordered, forwarding uuid + indices', () => {
    const event: SubscriptionQueueEvent = {
      __typename: 'QueueReordered',
      sequence: 4,
      stateHash: 'h',
      uuid: 'q-5',
      oldIndex: 2,
      newIndex: 0,
    };
    expect(toSyncQueueEvent(event)).toEqual({
      __typename: 'QueueReordered',
      uuid: 'q-5',
      oldIndex: 2,
      newIndex: 0,
    });
  });

  it('maps CurrentClimbChanged, preserving the currentItem alias plus echo hints', () => {
    const event: SubscriptionQueueEvent = {
      __typename: 'CurrentClimbChanged',
      sequence: 5,
      stateHash: 'h',
      currentItem: item,
      clientId: 'client-A',
      correlationId: 'corr-7',
    };
    expect(toSyncQueueEvent(event)).toEqual({
      __typename: 'CurrentClimbChanged',
      currentItem: item,
      clientId: 'client-A',
      correlationId: 'corr-7',
    });
  });

  it('maps CurrentClimbChanged with a null currentItem', () => {
    const event: SubscriptionQueueEvent = {
      __typename: 'CurrentClimbChanged',
      sequence: 5,
      stateHash: 'h',
      currentItem: null,
      clientId: null,
      correlationId: null,
    };
    const result = toSyncQueueEvent(event);
    expect(result.__typename).toBe('CurrentClimbChanged');
    if (result.__typename === 'CurrentClimbChanged') {
      expect(result.currentItem).toBeNull();
      expect(result.clientId).toBeNull();
      expect(result.correlationId).toBeNull();
    }
  });

  it('maps ClimbMirrored, preserving the mirroredUuid alias', () => {
    const event: SubscriptionQueueEvent = {
      __typename: 'ClimbMirrored',
      sequence: 6,
      stateHash: 'h',
      mirrored: true,
      mirroredUuid: 'q-3',
    };
    expect(toSyncQueueEvent(event)).toEqual({
      __typename: 'ClimbMirrored',
      mirrored: true,
      mirroredUuid: 'q-3',
    });
  });

  it('throws via the assertNever default branch for an unknown __typename', () => {
    const bogus = { __typename: 'NotARealVariant' } as unknown as SubscriptionQueueEvent;
    expect(() => toSyncQueueEvent(bogus)).toThrow(/Unhandled SubscriptionQueueEvent variant/);
  });
});
