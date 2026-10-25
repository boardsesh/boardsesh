import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createQueueSyncCoordinator,
  mapQueueEventToAction,
  generateClientId,
  generateCorrelationId,
  DEFAULT_PENDING_TTL_MS,
  type SyncQueueEvent,
} from '../sync-coordinator';
import type { Climb, ClimbQueueItem, QueueAction } from '../types';
import { queueReducer, initialState } from '../reducer';

const makeClimb = (uuid: string, name = 'Test Climb'): Climb => ({
  uuid,
  name,
  setter_username: 'tester',
  frames: '',
  angle: 40,
  ascensionist_count: 0,
  difficulty: '20',
  quality_average: '3',
  stars: 3,
  difficulty_error: '0',
  benchmark_difficulty: null,
});

const makeItem = (uuid: string, opts?: Partial<ClimbQueueItem>): ClimbQueueItem => ({
  uuid,
  climb: makeClimb(uuid),
  ...opts,
});

describe('mapQueueEventToAction', () => {
  it('maps FullSync to INITIAL_QUEUE_DATA', () => {
    const queue = [makeItem('a'), makeItem('b')];
    const event: SyncQueueEvent = {
      __typename: 'FullSync',
      state: { queue, currentClimbQueueItem: queue[0] },
    };
    const result = mapQueueEventToAction(event);
    expect(result.kind).toBe('dispatch');
    if (result.kind !== 'dispatch') return;
    expect(result.action.type).toBe('INITIAL_QUEUE_DATA');
    expect(result.action).toMatchObject({
      type: 'INITIAL_QUEUE_DATA',
      payload: { queue, currentClimbQueueItem: queue[0] },
    });
  });

  it('maps QueueItemAdded with `addedItem` (web schema)', () => {
    const item = makeItem('x');
    const event: SyncQueueEvent = { __typename: 'QueueItemAdded', addedItem: item, position: 2 };
    const result = mapQueueEventToAction(event);
    expect(result.kind).toBe('dispatch');
    if (result.kind !== 'dispatch') return;
    expect(result.action.type).toBe('DELTA_ADD_QUEUE_ITEM');
    expect(result.action).toMatchObject({ payload: { item, position: 2 } });
    expect(result.item).toBe(item);
  });

  it('maps QueueItemAdded with `item` (mobile schema)', () => {
    const item = makeItem('y');
    const event: SyncQueueEvent = { __typename: 'QueueItemAdded', item };
    const result = mapQueueEventToAction(event);
    expect(result.kind).toBe('dispatch');
    if (result.kind !== 'dispatch') return;
    expect(result.action).toMatchObject({
      type: 'DELTA_ADD_QUEUE_ITEM',
      payload: { item, position: undefined },
    });
  });

  it('ignores QueueItemAdded with no payload item', () => {
    const event: SyncQueueEvent = { __typename: 'QueueItemAdded' };
    const result = mapQueueEventToAction(event);
    expect(result.kind).toBe('ignore');
    if (result.kind !== 'ignore') return;
    expect(result.reason).toMatch(/no item/);
  });

  it('maps QueueItemRemoved to DELTA_REMOVE_QUEUE_ITEM', () => {
    const event: SyncQueueEvent = { __typename: 'QueueItemRemoved', uuid: 'removed-uuid' };
    const result = mapQueueEventToAction(event);
    expect(result.kind).toBe('dispatch');
    if (result.kind !== 'dispatch') return;
    expect(result.action).toEqual({
      type: 'DELTA_REMOVE_QUEUE_ITEM',
      payload: { uuid: 'removed-uuid' },
    });
  });

  it('maps QueueReordered to DELTA_REORDER_QUEUE_ITEM', () => {
    const event: SyncQueueEvent = {
      __typename: 'QueueReordered',
      uuid: 'r',
      oldIndex: 1,
      newIndex: 4,
    };
    const result = mapQueueEventToAction(event);
    expect(result.kind).toBe('dispatch');
    if (result.kind !== 'dispatch') return;
    expect(result.action).toEqual({
      type: 'DELTA_REORDER_QUEUE_ITEM',
      payload: { uuid: 'r', oldIndex: 1, newIndex: 4 },
    });
  });

  describe('CurrentClimbChanged', () => {
    it('maps with `currentItem` (web schema) and forwards clientId + correlationId', () => {
      const item = makeItem('current');
      const event: SyncQueueEvent = {
        __typename: 'CurrentClimbChanged',
        currentItem: item,
        clientId: 'peer-1',
        correlationId: 'corr-7',
      };
      const result = mapQueueEventToAction(event, { myClientId: 'me' });
      expect(result.kind).toBe('dispatch');
      if (result.kind !== 'dispatch') return;
      expect(result.action.type).toBe('DELTA_UPDATE_CURRENT_CLIMB');
      expect(result.action).toMatchObject({
        payload: {
          item,
          isServerEvent: true,
          eventClientId: 'peer-1',
          myClientId: 'me',
          serverCorrelationId: 'corr-7',
          // Always request insertion when an incoming item is present —
          // reducer's idempotent guard skips climbs already in the queue.
          shouldAddToQueue: true,
          // And when it does need inserting, slot it after the current climb
          // rather than at the end (issue #2217).
          insertAfterCurrent: true,
        },
      });
    });

    it('maps with `item` (mobile schema)', () => {
      const item = makeItem('current2');
      const event: SyncQueueEvent = { __typename: 'CurrentClimbChanged', item };
      const result = mapQueueEventToAction(event);
      expect(result.kind).toBe('dispatch');
      if (result.kind !== 'dispatch') return;
      expect(result.action).toMatchObject({ payload: { item, isServerEvent: true } });
    });

    it('requests insertion regardless of whether the incoming item carries `suggested`', () => {
      // Slim mobile subscription payloads omit `suggested`. The reducer's
      // idempotent guard handles already-queued climbs, so always asking for
      // insertion is safe and prevents state drift after a dropped insert.
      const slimItem = makeItem('slim');
      const event: SyncQueueEvent = { __typename: 'CurrentClimbChanged', currentItem: slimItem };
      const result = mapQueueEventToAction(event);
      expect(result.kind).toBe('dispatch');
      if (result.kind !== 'dispatch') return;
      expect(result.action).toMatchObject({ payload: { shouldAddToQueue: true } });
    });

    it('preserves an explicit `currentItem: null` (driver cleared the wall) and does NOT request insertion', () => {
      const event: SyncQueueEvent = { __typename: 'CurrentClimbChanged', currentItem: null };
      const result = mapQueueEventToAction(event);
      expect(result.kind).toBe('dispatch');
      if (result.kind !== 'dispatch') return;
      expect(result.action).toMatchObject({ payload: { item: null, shouldAddToQueue: false } });
    });
  });

  it('maps ClimbMirrored to DELTA_MIRROR_CURRENT_CLIMB', () => {
    const event: SyncQueueEvent = {
      __typename: 'ClimbMirrored',
      mirrored: true,
      mirroredUuid: 'mirror-target',
    };
    const result = mapQueueEventToAction(event);
    expect(result.kind).toBe('dispatch');
    if (result.kind !== 'dispatch') return;
    expect(result.action).toEqual({
      type: 'DELTA_MIRROR_CURRENT_CLIMB',
      payload: { mirrored: true, mirroredUuid: 'mirror-target' },
    });
  });

  it('coerces missing mirroredUuid to null', () => {
    const event: SyncQueueEvent = { __typename: 'ClimbMirrored', mirrored: false };
    const result = mapQueueEventToAction(event);
    expect(result.kind).toBe('dispatch');
    if (result.kind !== 'dispatch') return;
    expect(result.action).toMatchObject({ payload: { mirroredUuid: null } });
  });
});

describe('issue #2217 — peer takes control (map → reducer end-to-end)', () => {
  it('slots a peer-activated new climb after the current climb, not at the end', () => {
    const itemA = makeItem('item-a');
    const itemB = makeItem('item-b');
    const itemC = makeItem('item-c');
    const state = {
      ...initialState({}),
      queue: [itemA, itemB, itemC],
      currentClimbQueueItem: itemA,
    };

    // A peer lights up a brand-new climb → server broadcasts CurrentClimbChanged.
    const peerItem = makeItem('item-x');
    const event: SyncQueueEvent = {
      __typename: 'CurrentClimbChanged',
      currentItem: peerItem,
      clientId: 'peer-1',
    };

    const mapped = mapQueueEventToAction(event, { myClientId: 'me' });
    expect(mapped.kind).toBe('dispatch');
    if (mapped.kind !== 'dispatch') return;

    const next = queueReducer(state, mapped.action);
    expect(next.queue.map((queueItem) => queueItem.uuid)).toEqual(['item-a', 'item-x', 'item-b', 'item-c']);
    expect(next.currentClimbQueueItem?.uuid).toBe('item-x');
  });
});

describe('createQueueSyncCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses provided clientId verbatim', () => {
    const coordinator = createQueueSyncCoordinator({ dispatch: () => {}, clientId: 'fixed-id' });
    expect(coordinator.clientId).toBe('fixed-id');
  });

  it('auto-generates a clientId when not provided', () => {
    const coordinator = createQueueSyncCoordinator({ dispatch: () => {} });
    expect(coordinator.clientId).toMatch(/.+/);
    expect(coordinator.clientId.length).toBeGreaterThan(8);
  });

  it('threads myClientId into mapIncomingEvent results', () => {
    const coordinator = createQueueSyncCoordinator({ dispatch: () => {}, clientId: 'me' });
    const item = makeItem('x');
    const result = coordinator.mapIncomingEvent({
      __typename: 'CurrentClimbChanged',
      currentItem: item,
      clientId: 'peer',
    });
    expect(result.kind).toBe('dispatch');
    if (result.kind !== 'dispatch') return;
    expect(result.action).toMatchObject({
      payload: { eventClientId: 'peer', myClientId: 'me' },
    });
  });

  it('schedules a CLEANUP_PENDING_UPDATE dispatch after the TTL', () => {
    const dispatched: QueueAction[] = [];
    const coordinator = createQueueSyncCoordinator({
      dispatch: (action) => dispatched.push(action as QueueAction),
      clientId: 'me',
      pendingTtlMs: 5000,
    });
    coordinator.trackPendingMutation('corr-a');
    expect(dispatched).toEqual([]);
    vi.advanceTimersByTime(4999);
    expect(dispatched).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(dispatched).toEqual([{ type: 'CLEANUP_PENDING_UPDATE', payload: { correlationId: 'corr-a' } }]);
  });

  it('honors a per-call TTL override', () => {
    const dispatched: QueueAction[] = [];
    const coordinator = createQueueSyncCoordinator({
      dispatch: (action) => dispatched.push(action as QueueAction),
      pendingTtlMs: 60_000,
    });
    coordinator.trackPendingMutation('corr-x', 1000);
    vi.advanceTimersByTime(1000);
    expect(dispatched).toEqual([{ type: 'CLEANUP_PENDING_UPDATE', payload: { correlationId: 'corr-x' } }]);
  });

  it('replaces an earlier scheduled cleanup when the same id is tracked again', () => {
    const dispatched: QueueAction[] = [];
    const coordinator = createQueueSyncCoordinator({
      dispatch: (action) => dispatched.push(action as QueueAction),
      pendingTtlMs: 1000,
    });
    coordinator.trackPendingMutation('corr-a');
    vi.advanceTimersByTime(500);
    coordinator.trackPendingMutation('corr-a'); // resets the timer
    vi.advanceTimersByTime(500);
    expect(dispatched).toEqual([]); // would have fired without reset
    vi.advanceTimersByTime(500);
    expect(dispatched).toHaveLength(1);
  });

  it('dispose cancels pending cleanups so no dispatch fires after unmount', () => {
    const dispatched: QueueAction[] = [];
    const coordinator = createQueueSyncCoordinator({
      dispatch: (action) => dispatched.push(action as QueueAction),
      pendingTtlMs: 1000,
    });
    coordinator.trackPendingMutation('corr-a');
    coordinator.trackPendingMutation('corr-b');
    coordinator.dispose();
    vi.advanceTimersByTime(5000);
    expect(dispatched).toEqual([]);
  });

  it('uses injected scheduleCleanup', () => {
    const scheduled: { cb: () => void; delay: number }[] = [];
    const cancels: number[] = [];
    let nextId = 0;
    const coordinator = createQueueSyncCoordinator({
      dispatch: () => {},
      scheduleCleanup: (cb, delay) => {
        const id = ++nextId;
        scheduled.push({ cb, delay });
        return () => cancels.push(id);
      },
    });
    coordinator.trackPendingMutation('corr-a');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delay).toBe(DEFAULT_PENDING_TTL_MS);
    coordinator.dispose();
    expect(cancels).toEqual([1]);
  });

  it('generateCorrelationId returns unique strings', () => {
    const coordinator = createQueueSyncCoordinator({ dispatch: () => {} });
    const ids = new Set([
      coordinator.generateCorrelationId(),
      coordinator.generateCorrelationId(),
      coordinator.generateCorrelationId(),
    ]);
    expect(ids.size).toBe(3);
  });
});

describe('standalone id generators', () => {
  it('generateClientId returns a non-empty string', () => {
    expect(generateClientId()).toMatch(/.+/);
  });

  it('generateCorrelationId returns a non-empty string', () => {
    expect(generateCorrelationId()).toMatch(/.+/);
  });
});

describe('FullSync historyCount (F3)', () => {
  it('passes the line through to INITIAL_QUEUE_DATA', () => {
    const result = mapQueueEventToAction({
      __typename: 'FullSync',
      state: { queue: [], currentClimbQueueItem: null, historyCount: 3 },
    });
    expect(result.kind === 'dispatch' && result.action.type === 'INITIAL_QUEUE_DATA' && result.action.payload).toEqual({
      queue: [],
      currentClimbQueueItem: null,
      historyCount: 3,
      currentChangedAt: null,
    });
  });

  it("passes the room's currentChangedAt through for the #4979 hold clock", () => {
    const result = mapQueueEventToAction({
      __typename: 'FullSync',
      state: { queue: [], currentClimbQueueItem: null, historyCount: 0, currentChangedAt: '2026-10-20T08:00:00.000Z' },
    });
    expect(
      result.kind === 'dispatch' &&
        result.action.type === 'INITIAL_QUEUE_DATA' &&
        result.action.payload.currentChangedAt,
    ).toBe('2026-10-20T08:00:00.000Z');
  });

  it('reads a legacy FullSync without the field as null', () => {
    const result = mapQueueEventToAction({ __typename: 'FullSync', state: { queue: [], currentClimbQueueItem: null } });
    expect(result.kind === 'dispatch' && result.action.type === 'INITIAL_QUEUE_DATA' && result.action.payload).toEqual({
      queue: [],
      currentClimbQueueItem: null,
      historyCount: null,
      currentChangedAt: null,
    });
  });
});
