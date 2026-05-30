// Web-integration coverage for the `SubscriptionQueueEvent` (from
// `@boardsesh/shared-schema`) → `SubscriptionWireEnvelope<ClimbQueueItem>`
// (from `@boardsesh/queue-runtime`) → reducer-action pipeline.
//
// The shared adapter has its own unit tests in
// `packages/shared/queue-runtime/src/__tests__/subscription-adapter.test.ts`,
// but those exercise the adapter in isolation with synthetic wire types. This
// suite runs the same shapes that the live web subscription receives —
// `SubscriptionQueueEvent` carries server bookkeeping (`sequence`, `stateHash`)
// the adapter discards, plus the echo-suppression hints the reducer relies on.
// If a new event variant lands in shared-schema, `toWireEnvelope`'s
// `assertNever` default trips at compile time; the runtime regression-tests
// here lock the per-variant rebuild against drift.

import { describe, it, expect } from 'vite-plus/test';
import type { Climb, ClimbQueueItem, SubscriptionQueueEvent } from '@boardsesh/shared-schema';
import { mapSubscriptionEnvelopeToAction } from '@boardsesh/queue-runtime';
import { toWireEnvelope } from '../use-queue-event-subscription';

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

const dispatch = (event: SubscriptionQueueEvent, myClientId?: string) =>
  mapSubscriptionEnvelopeToAction(toWireEnvelope(event), { context: { myClientId } });

describe('web wire envelope pipeline (toWireEnvelope → mapSubscriptionEnvelopeToAction)', () => {
  it('maps FullSync to INITIAL_QUEUE_DATA', () => {
    const result = dispatch({
      __typename: 'FullSync',
      sequence: 1,
      state: { sequence: 1, stateHash: 'h', queue: [item], currentClimbQueueItem: item },
    });
    expect(result.kind).toBe('dispatch');
    if (result.kind !== 'dispatch') return;
    expect(result.action.type).toBe('INITIAL_QUEUE_DATA');
    if (result.action.type !== 'INITIAL_QUEUE_DATA') return;
    expect(result.action.payload.queue.map((q) => q.uuid)).toEqual(['q-1']);
    expect(result.action.payload.currentClimbQueueItem?.uuid).toBe('q-1');
  });

  it('forwards a null currentClimbQueueItem on FullSync', () => {
    const result = dispatch({
      __typename: 'FullSync',
      sequence: 1,
      state: { sequence: 1, stateHash: 'h', queue: [], currentClimbQueueItem: null },
    });
    if (result.kind !== 'dispatch' || result.action.type !== 'INITIAL_QUEUE_DATA') {
      throw new Error('expected INITIAL_QUEUE_DATA');
    }
    expect(result.action.payload.currentClimbQueueItem).toBeNull();
  });

  it('maps QueueItemAdded (addedItem alias) to DELTA_ADD_QUEUE_ITEM', () => {
    const result = dispatch({
      __typename: 'QueueItemAdded',
      sequence: 2,
      stateHash: 'h',
      addedItem: item,
      position: 3,
    });
    if (result.kind !== 'dispatch' || result.action.type !== 'DELTA_ADD_QUEUE_ITEM') {
      throw new Error('expected DELTA_ADD_QUEUE_ITEM');
    }
    expect(result.action.payload.item.uuid).toBe('q-1');
    expect(result.action.payload.position).toBe(3);
  });

  it('maps QueueItemRemoved to DELTA_REMOVE_QUEUE_ITEM', () => {
    const result = dispatch({
      __typename: 'QueueItemRemoved',
      sequence: 3,
      stateHash: 'h',
      uuid: 'q-9',
    });
    if (result.kind !== 'dispatch' || result.action.type !== 'DELTA_REMOVE_QUEUE_ITEM') {
      throw new Error('expected DELTA_REMOVE_QUEUE_ITEM');
    }
    expect(result.action.payload.uuid).toBe('q-9');
  });

  it('maps QueueReordered to DELTA_REORDER_QUEUE_ITEM forwarding indices', () => {
    const result = dispatch({
      __typename: 'QueueReordered',
      sequence: 4,
      stateHash: 'h',
      uuid: 'q-5',
      oldIndex: 2,
      newIndex: 0,
    });
    if (result.kind !== 'dispatch' || result.action.type !== 'DELTA_REORDER_QUEUE_ITEM') {
      throw new Error('expected DELTA_REORDER_QUEUE_ITEM');
    }
    expect(result.action.payload).toEqual({ uuid: 'q-5', oldIndex: 2, newIndex: 0 });
  });

  it('maps CurrentClimbChanged carrying echo hints to DELTA_UPDATE_CURRENT_CLIMB', () => {
    const result = dispatch(
      {
        __typename: 'CurrentClimbChanged',
        sequence: 5,
        stateHash: 'h',
        currentItem: item,
        clientId: 'peer-A',
        correlationId: 'corr-7',
      },
      'self',
    );
    if (result.kind !== 'dispatch' || result.action.type !== 'DELTA_UPDATE_CURRENT_CLIMB') {
      throw new Error('expected DELTA_UPDATE_CURRENT_CLIMB');
    }
    expect(result.action.payload.eventClientId).toBe('peer-A');
    expect(result.action.payload.myClientId).toBe('self');
    expect(result.action.payload.serverCorrelationId).toBe('corr-7');
    expect(result.action.payload.item?.uuid).toBe('q-1');
  });

  it('forwards a null currentItem (driver cleared) plus null echo hints', () => {
    const result = dispatch({
      __typename: 'CurrentClimbChanged',
      sequence: 5,
      stateHash: 'h',
      currentItem: null,
      clientId: null,
      correlationId: null,
    });
    if (result.kind !== 'dispatch' || result.action.type !== 'DELTA_UPDATE_CURRENT_CLIMB') {
      throw new Error('expected DELTA_UPDATE_CURRENT_CLIMB');
    }
    expect(result.action.payload.item).toBeNull();
  });

  it('maps ClimbMirrored to DELTA_MIRROR_CURRENT_CLIMB (mirroredUuid alias)', () => {
    const result = dispatch({
      __typename: 'ClimbMirrored',
      sequence: 6,
      stateHash: 'h',
      mirrored: true,
      mirroredUuid: 'q-3',
    });
    if (result.kind !== 'dispatch' || result.action.type !== 'DELTA_MIRROR_CURRENT_CLIMB') {
      throw new Error('expected DELTA_MIRROR_CURRENT_CLIMB');
    }
    expect(result.action.payload).toEqual({ mirrored: true, mirroredUuid: 'q-3' });
  });

  it('throws via assertNever for an unknown __typename (drift guard)', () => {
    const bogus = { __typename: 'NotARealVariant' } as unknown as SubscriptionQueueEvent;
    expect(() => toWireEnvelope(bogus)).toThrow(/Unhandled SubscriptionQueueEvent variant/);
  });

  it('normalises undefined echo hints to undefined in the action payload (drift guard on CurrentClimbChanged)', () => {
    // If the server schema ever changes from sending `clientId` /
    // `correlationId: null` to omitting them entirely, the pipeline must
    // not regress: the action payload should still surface them as
    // `undefined` (not `null`), because the reducer's echo-suppression
    // check is `eventClientId === myClientId` and silently changing the
    // sentinel between releases (e.g. `null` → `undefined`) could break
    // suppression for clients that haven't yet redeployed.
    //
    // Today the chain is: wire undefined → SubscriptionWireEnvelope
    // coerces to null → mapQueueEventToAction coerces back to undefined.
    // That round-trip is the contract this test locks in.
    const envelope = {
      __typename: 'CurrentClimbChanged',
      sequence: 5,
      stateHash: 'h',
      currentItem: item,
      clientId: undefined as unknown as string,
      correlationId: undefined as unknown as string,
    } as unknown as SubscriptionQueueEvent;
    const result = dispatch(envelope, 'self');
    if (result.kind !== 'dispatch' || result.action.type !== 'DELTA_UPDATE_CURRENT_CLIMB') {
      throw new Error('expected DELTA_UPDATE_CURRENT_CLIMB');
    }
    expect(result.action.payload.eventClientId).toBeUndefined();
    expect(result.action.payload.serverCorrelationId).toBeUndefined();
  });
});
