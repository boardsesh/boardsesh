import { describe, it, expect } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { mapSubscriptionEnvelopeToAction, type SubscriptionWireEnvelope } from '../subscription-adapter';

type WireClimb = {
  uuid: string;
  name: string;
  frames: string;
};

type WireItem = {
  uuid: string;
  climb: WireClimb;
};

const liftToClimbItem = (wire: WireItem): ClimbQueueItem => ({
  uuid: wire.uuid,
  climb: {
    uuid: wire.climb.uuid,
    name: wire.climb.name,
    frames: wire.climb.frames,
    setter_username: '',
    angle: 0,
    ascensionist_count: 0,
    difficulty: '',
    quality_average: '',
    stars: 0,
    difficulty_error: '',
    benchmark_difficulty: null,
  },
});

const wireItem = (uuid: string): WireItem => ({
  uuid,
  climb: { uuid: `c-${uuid}`, name: uuid, frames: '' },
});

describe('mapSubscriptionEnvelopeToAction', () => {
  it('lifts FullSync items and dispatches INITIAL_QUEUE_DATA', () => {
    const envelope: SubscriptionWireEnvelope<WireItem> = {
      __typename: 'FullSync',
      state: {
        queue: [wireItem('a'), wireItem('b')],
        currentClimbQueueItem: wireItem('a'),
      },
    };

    const result = mapSubscriptionEnvelopeToAction(envelope, { mapItem: liftToClimbItem });

    expect(result.kind).toBe('dispatch');
    if (result.kind !== 'dispatch') return;
    expect(result.eventType).toBe('FullSync');
    expect(result.action.type).toBe('INITIAL_QUEUE_DATA');
    if (result.action.type !== 'INITIAL_QUEUE_DATA') return;
    expect(result.action.payload.queue.map((i) => i.uuid)).toEqual(['a', 'b']);
    expect(result.action.payload.currentClimbQueueItem?.uuid).toBe('a');
    expect(result.action.payload.queue[0].climb.setter_username).toBe('');
  });

  it('handles QueueItemAdded with either addedItem (mobile alias) or item (web)', () => {
    const mobileEnvelope: SubscriptionWireEnvelope<WireItem> = {
      __typename: 'QueueItemAdded',
      addedItem: wireItem('m'),
      position: 0,
    };
    const webEnvelope: SubscriptionWireEnvelope<WireItem> = {
      __typename: 'QueueItemAdded',
      item: wireItem('w'),
      position: 1,
    };

    const mobile = mapSubscriptionEnvelopeToAction(mobileEnvelope, { mapItem: liftToClimbItem });
    const web = mapSubscriptionEnvelopeToAction(webEnvelope, { mapItem: liftToClimbItem });

    expect(mobile.kind === 'dispatch' && mobile.item?.uuid).toBe('m');
    expect(web.kind === 'dispatch' && web.item?.uuid).toBe('w');
  });

  it('ignores QueueItemAdded with no item on either alias', () => {
    const envelope: SubscriptionWireEnvelope<WireItem> = {
      __typename: 'QueueItemAdded',
      position: 0,
    };
    const result = mapSubscriptionEnvelopeToAction(envelope, { mapItem: liftToClimbItem });
    expect(result.kind).toBe('ignore');
  });

  it('passes myClientId through for CurrentClimbChanged echo suppression', () => {
    const envelope: SubscriptionWireEnvelope<WireItem> = {
      __typename: 'CurrentClimbChanged',
      currentItem: wireItem('a'),
      clientId: 'peer-1',
      correlationId: 'corr-1',
    };
    const result = mapSubscriptionEnvelopeToAction(envelope, {
      mapItem: liftToClimbItem,
      context: { myClientId: 'self' },
    });

    expect(result.kind).toBe('dispatch');
    if (result.kind !== 'dispatch') return;
    expect(result.action.type).toBe('DELTA_UPDATE_CURRENT_CLIMB');
    if (result.action.type !== 'DELTA_UPDATE_CURRENT_CLIMB') return;
    expect(result.action.payload.eventClientId).toBe('peer-1');
    expect(result.action.payload.myClientId).toBe('self');
    expect(result.action.payload.serverCorrelationId).toBe('corr-1');
  });

  it('treats CurrentClimbChanged with currentItem:null as a clear, not a fallthrough to item alias', () => {
    const envelope: SubscriptionWireEnvelope<WireItem> = {
      __typename: 'CurrentClimbChanged',
      currentItem: null,
      item: wireItem('shadow'),
    };
    const result = mapSubscriptionEnvelopeToAction(envelope, { mapItem: liftToClimbItem });

    expect(result.kind).toBe('dispatch');
    if (result.kind !== 'dispatch' || result.action.type !== 'DELTA_UPDATE_CURRENT_CLIMB') return;
    expect(result.action.payload.item).toBeNull();
  });

  it('accepts ClimbMirrored under either mirroredUuid (mobile alias) or uuid (web)', () => {
    const mobile: SubscriptionWireEnvelope<WireItem> = {
      __typename: 'ClimbMirrored',
      mirrored: true,
      mirroredUuid: 'climb-1',
    };
    const web: SubscriptionWireEnvelope<WireItem> = {
      __typename: 'ClimbMirrored',
      mirrored: false,
      uuid: 'climb-2',
    };

    const mobileResult = mapSubscriptionEnvelopeToAction(mobile);
    const webResult = mapSubscriptionEnvelopeToAction(web);

    expect(mobileResult.kind === 'dispatch' && mobileResult.action.type).toBe('DELTA_MIRROR_CURRENT_CLIMB');
    if (mobileResult.kind === 'dispatch' && mobileResult.action.type === 'DELTA_MIRROR_CURRENT_CLIMB') {
      expect(mobileResult.action.payload.mirroredUuid).toBe('climb-1');
      expect(mobileResult.action.payload.mirrored).toBe(true);
    }
    if (webResult.kind === 'dispatch' && webResult.action.type === 'DELTA_MIRROR_CURRENT_CLIMB') {
      expect(webResult.action.payload.mirroredUuid).toBe('climb-2');
      expect(webResult.action.payload.mirrored).toBe(false);
    }
  });

  it('defaults to identity lift when mapItem is omitted (web wire items already match)', () => {
    // Simulating web: wire item already matches ClimbQueueItem shape.
    const directItem: ClimbQueueItem = {
      uuid: 'x',
      climb: {
        uuid: 'cx',
        name: 'X',
        frames: '',
        setter_username: 'u',
        angle: 40,
        ascensionist_count: 0,
        difficulty: '20',
        quality_average: '3',
        stars: 3,
        difficulty_error: '0',
        benchmark_difficulty: null,
      },
    };
    const envelope: SubscriptionWireEnvelope<ClimbQueueItem> = {
      __typename: 'QueueItemAdded',
      item: directItem,
      position: 0,
    };
    const result = mapSubscriptionEnvelopeToAction(envelope);
    expect(result.kind === 'dispatch' && result.item).toBe(directItem);
  });

  it('forwards QueueReordered uuid + indices to the reducer', () => {
    const envelope: SubscriptionWireEnvelope<WireItem> = {
      __typename: 'QueueReordered',
      uuid: 'q-1',
      oldIndex: 2,
      newIndex: 0,
    };
    const result = mapSubscriptionEnvelopeToAction(envelope);
    expect(result.kind === 'dispatch' && result.action.type).toBe('DELTA_REORDER_QUEUE_ITEM');
    if (result.kind === 'dispatch' && result.action.type === 'DELTA_REORDER_QUEUE_ITEM') {
      expect(result.action.payload).toEqual({ uuid: 'q-1', oldIndex: 2, newIndex: 0 });
    }
  });
});
