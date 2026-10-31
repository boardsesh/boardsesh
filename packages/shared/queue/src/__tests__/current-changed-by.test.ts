import { describe, expect, it } from 'vitest';
import { initialState, queueReducer } from '../reducer';
import type { ClimbQueueItem, QueueAction, QueueState } from '../types';

function item(uuid: string): ClimbQueueItem {
  return {
    uuid,
    addedByUser: { id: 'queue-author', username: 'Alice' },
    climb: {
      uuid: `climb-${uuid}`,
      name: uuid,
      setter_username: 'setter',
      frames: '',
      angle: 40,
      ascensionist_count: 0,
      difficulty: '20',
      quality_average: '3',
      stars: 3,
      difficulty_error: '0',
      benchmark_difficulty: null,
    },
  };
}

describe.each([false, true])('currentChangedBy (now-slot %s)', (nowSlotMode) => {
  const current = item('current');
  const next = item('next');
  const state = (overrides: Partial<QueueState> = {}): QueueState => ({
    ...initialState({}),
    queue: [current, next],
    currentClimbQueueItem: current,
    currentChangedBy: 'previous-mover',
    nowSlotMode,
    historyCount: nowSlotMode ? 0 : null,
    ...overrides,
  });

  it('records the server mover rather than the queue author for both event forms', () => {
    const actions: QueueAction[] = [
      {
        type: 'INITIAL_QUEUE_DATA',
        payload: { queue: [current, next], currentClimbQueueItem: next, currentChangedBy: 'participant-bob' },
      },
      {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item: next, isServerEvent: true, currentChangedBy: 'participant-bob' },
      },
    ];
    for (const action of actions) {
      const result = queueReducer(state(), action);
      expect(result.currentChangedBy).toBe('participant-bob');
      expect(result.currentClimbQueueItem?.addedByUser?.id).toBe('queue-author');
    }
  });

  it('clears an old actor on actor-free authoritative snapshots and pointer events, even for the same item', () => {
    const actions: QueueAction[] = [
      { type: 'INITIAL_QUEUE_DATA', payload: { queue: [current, next], currentClimbQueueItem: current } },
      { type: 'DELTA_UPDATE_CURRENT_CLIMB', payload: { item: current, isServerEvent: true } },
      {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item: next, isServerEvent: true, currentChangedBy: null },
      },
    ];
    for (const action of actions) expect(queueReducer(state(), action).currentChangedBy).toBeNull();
  });

  it('clears attribution on local moves and current removal without naming the queue author', () => {
    const actions: QueueAction[] = [
      { type: 'SET_CURRENT_CLIMB', payload: next },
      { type: 'SET_CURRENT_CLIMB_QUEUE_ITEM', payload: next },
      { type: 'DELTA_UPDATE_CURRENT_CLIMB', payload: { item: next } },
      { type: 'UPDATE_QUEUE', payload: { queue: [current, next], currentClimbQueueItem: next } },
      { type: 'DELTA_REMOVE_QUEUE_ITEM', payload: { uuid: current.uuid } },
      { type: 'CLEAR_QUEUE' },
      { type: 'INITIAL_QUEUE_DATA', payload: { queue: [], currentClimbQueueItem: null } },
    ];
    for (const action of actions) expect(queueReducer(state(), action).currentChangedBy).toBeNull();
  });

  it('preserves attribution through unrelated queue edits, payload refreshes and mirror changes', () => {
    const actions: QueueAction[] = [
      { type: 'ADD_TO_QUEUE', payload: item('third') },
      { type: 'DELTA_REMOVE_QUEUE_ITEM', payload: { uuid: next.uuid } },
      { type: 'UPDATE_QUEUE', payload: { queue: [next, current], currentClimbQueueItem: current } },
      { type: 'MIRROR_CLIMB' },
      { type: 'DELTA_MIRROR_CURRENT_CLIMB', payload: { mirrored: true, mirroredUuid: current.climb.uuid } },
      {
        type: 'REFRESH_AUTHORED_CLIMB',
        payload: { climbUuid: current.climb.uuid, patch: { name: 'Updated', frames: '' } },
      },
    ];
    for (const action of actions) expect(queueReducer(state(), action).currentChangedBy).toBe('previous-mover');
  });

  it('clears attribution explicitly when credentials change while the current climb stays', () => {
    const result = queueReducer(state(), {
      type: 'UPDATE_QUEUE',
      payload: { queue: [current, next], currentClimbQueueItem: current, currentChangedBy: null },
    });
    expect(result.currentClimbQueueItem).toBe(current);
    expect(result.currentChangedBy).toBeNull();
  });

  it.each(['correlation', 'client'] as const)('accepts authoritative metadata on the current %s echo', (echoKind) => {
    const result = queueReducer(state({ pendingCurrentClimbUpdates: ['own-correlation'] }), {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: {
        item: current,
        isServerEvent: true,
        currentChangedBy: 'own-participant',
        ...(echoKind === 'correlation'
          ? { serverCorrelationId: 'own-correlation' }
          : { eventClientId: 'own-connection', myClientId: 'own-connection' }),
      },
    });
    expect(result.currentChangedBy).toBe('own-participant');
  });

  it('does not stamp an overtaken own echo onto the newer current item', () => {
    const result = queueReducer(
      state({ currentClimbQueueItem: next, currentChangedBy: 'newer-mover', pendingCurrentClimbUpdates: ['old'] }),
      {
        type: 'DELTA_UPDATE_CURRENT_CLIMB',
        payload: { item: current, isServerEvent: true, serverCorrelationId: 'old', currentChangedBy: 'old-mover' },
      },
    );
    expect(result.currentClimbQueueItem?.uuid).toBe(next.uuid);
    expect(result.currentChangedBy).toBe('newer-mover');
  });

  it('does not stamp a protected optimistic move with its older snapshot actor', () => {
    const optimistic = queueReducer(state({ serverSequence: 8, serverSequenceSessionId: 'room' }), {
      type: 'DELTA_UPDATE_CURRENT_CLIMB',
      payload: { item: next, correlationId: 'pending', sessionId: 'room' },
    });
    expect(optimistic.currentChangedBy).toBeNull();
    const result = queueReducer(optimistic, {
      type: 'INITIAL_QUEUE_DATA',
      serverSequence: 8,
      payload: {
        queue: [current, next],
        currentClimbQueueItem: current,
        sessionId: 'room',
        currentChangedBy: 'old-mover',
      },
    });
    expect(result.currentClimbQueueItem?.uuid).toBe(next.uuid);
    expect(result.currentChangedBy).toBeNull();
  });
});
