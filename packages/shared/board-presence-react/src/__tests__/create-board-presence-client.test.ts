import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BoardPresenceEvent, ClimbQueueItemInput } from '@boardsesh/shared-schema';
import { createBoardPresenceClient, type BoardPresenceTransport } from '../create-board-presence-client';
import { boardHistoryCursor } from '../types';

function makeClimb(climbUuid: string) {
  return { climbUuid, seq: 1, sentAt: '2026-06-09T00:00:00.000Z', name: `Climb ${climbUuid}`, angle: 40 };
}

// A fake transport that just records every call so we can assert the factory
// wires the right operation strings + variables and unwraps the right
// response field — the same shape both platform adapters bind to their
// graphql-ws `Client`, without a real websocket.
function makeTransport() {
  const executeCalls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  const execute = vi.fn(async (operation: { query: string; variables?: Record<string, unknown> }) => {
    executeCalls.push(operation);
    return executeMock.mockResult;
  });
  const executeMock: { mockResult: unknown } = { mockResult: undefined };

  const subscribeCalls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  let lastSink: { next: (data: unknown) => void; error: (err: unknown) => void; complete: () => void } | null = null;
  const unsubscribe = vi.fn();
  const subscribe = vi.fn(
    (
      operation: { query: string; variables?: Record<string, unknown> },
      sink: { next: (data: unknown) => void; error: (err: unknown) => void; complete: () => void },
    ) => {
      subscribeCalls.push(operation);
      lastSink = sink;
      return unsubscribe;
    },
  );

  const connectedListeners: Array<() => void> = [];
  const onConnectedUnsubscribe = vi.fn();
  // Unsubscribe really removes the listener (like graphql-ws's `on`), so tests
  // can assert an unsubscribed registration stops receiving events.
  const onConnected = vi.fn((callback: () => void) => {
    connectedListeners.push(callback);
    return () => {
      onConnectedUnsubscribe();
      const listenerIndex = connectedListeners.indexOf(callback);
      if (listenerIndex !== -1) connectedListeners.splice(listenerIndex, 1);
    };
  });

  // `vi.fn()` produces a concretely-typed mock (always `Promise<unknown>`),
  // which can't structurally satisfy the transport's generic `execute<TData>`
  // signature — the real adapters use generic method shorthand instead (see
  // `create-board-presence-client.ts`'s two platform wrappers). The cast is
  // safe here: every call site in the factory casts its own expected shape.
  const transport = { execute, subscribe, onConnected } as unknown as BoardPresenceTransport;

  return {
    transport,
    execute,
    executeCalls,
    setExecuteResult: (value: unknown) => {
      executeMock.mockResult = value;
    },
    subscribe,
    subscribeCalls,
    getLastSink: () => lastSink,
    unsubscribe,
    onConnected,
    connectedListeners,
    onConnectedUnsubscribe,
    fireConnected: () => connectedListeners.forEach((listener) => listener()),
  };
}

describe('createBoardPresenceClient', () => {
  let harness: ReturnType<typeof makeTransport>;

  beforeEach(() => {
    harness = makeTransport();
  });

  it('subscribes to BOARD_NOW_PLAYING and forwards set events to the callback', () => {
    const client = createBoardPresenceClient(harness.transport);
    const onEvent = vi.fn();
    const onError = vi.fn();
    const onComplete = vi.fn();

    const unsub = client.subscribeNowPlaying(42, onEvent, onError, onComplete);

    expect(harness.subscribe).toHaveBeenCalledTimes(1);
    expect(harness.subscribeCalls[0].variables).toEqual({ boardId: 42 });
    expect(harness.subscribeCalls[0].query).toContain('boardNowPlaying');

    const event: BoardPresenceEvent = { __typename: 'BoardClimbSet', climb: makeClimb('c1') };
    harness.getLastSink()?.next({ boardNowPlaying: event });
    expect(onEvent).toHaveBeenCalledWith(event);

    harness.getLastSink()?.error(new Error('socket dropped'));
    expect(onError).toHaveBeenCalledWith(new Error('socket dropped'));

    harness.getLastSink()?.complete();
    expect(onComplete).toHaveBeenCalledTimes(1);

    expect(typeof unsub).toBe('function');
    unsub();
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not forward an empty now-playing payload', () => {
    const client = createBoardPresenceClient(harness.transport);
    const onEvent = vi.fn();
    client.subscribeNowPlaying(1, onEvent);
    harness.getLastSink()?.next({});
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('fetches recent climbs and unwraps the boardRecentClimbs field, falling back to [] when missing', async () => {
    const client = createBoardPresenceClient(harness.transport);
    const recent = [makeClimb('c2'), makeClimb('c3')];
    harness.setExecuteResult({ boardRecentClimbs: recent });

    const climbs = await client.fetchRecentClimbs(7);

    expect(climbs).toEqual(recent);
    expect(harness.executeCalls[0].variables).toEqual({ boardId: 7 });
    expect(harness.executeCalls[0].query).toContain('boardRecentClimbs');

    harness.setExecuteResult({});
    expect(await client.fetchRecentClimbs(7)).toEqual([]);
  });

  it('fetches durable history, forwarding limit + before and unwrapping boardHistory, falling back to []', async () => {
    const client = createBoardPresenceClient(harness.transport);
    const history = [makeClimb('h1'), makeClimb('h2')];
    harness.setExecuteResult({ boardHistory: history });

    const climbs = await client.fetchHistory(7, { limit: 25, before: boardHistoryCursor(900) });

    expect(climbs).toEqual(history);
    expect(harness.executeCalls[0].variables).toEqual({ boardId: 7, limit: 25, before: '900' });
    expect(harness.executeCalls[0].query).toContain('boardHistory');

    harness.setExecuteResult({ boardHistory: [] });
    await client.fetchHistory(7);
    expect(harness.executeCalls[1].variables).toEqual({ boardId: 7, limit: null, before: null });

    harness.setExecuteResult({});
    expect(await client.fetchHistory(7)).toEqual([]);
  });

  it('fetches recent climb senders with the board, climb, and angle, falling back to []', async () => {
    const client = createBoardPresenceClient(harness.transport);
    const senders = [
      {
        userId: 'u1',
        displayName: 'Alex',
        avatarUrl: 'https://example.test/alex.png',
        lastSentAt: '2026-07-31T12:00:00.000Z',
      },
    ];
    harness.setExecuteResult({ boardClimbRecentSenders: senders });

    expect(await client.fetchClimbRecentSenders(7, 'climb-1', 40)).toEqual(senders);
    expect(harness.executeCalls[0].variables).toEqual({ boardId: 7, climbUuid: 'climb-1', angle: 40 });
    expect(harness.executeCalls[0].query).toContain('boardClimbRecentSenders');

    harness.setExecuteResult({});
    expect(await client.fetchClimbRecentSenders(7, 'climb-1', 40)).toEqual([]);
  });

  it('fetches stats and unwraps the boardPresenceStats field', async () => {
    const client = createBoardPresenceClient(harness.transport);
    const stats = {
      climbsSentCount: 3,
      distinctClimbersCount: 2,
      hardestGrade: 'V7',
      topGrade: 'V4',
      lastSentAt: null,
    };
    harness.setExecuteResult({ boardPresenceStats: stats });

    const result = await client.fetchStats(9);

    expect(result).toEqual(stats);
    expect(harness.executeCalls[0].variables).toEqual({ boardId: 9 });
    expect(harness.executeCalls[0].query).toContain('boardPresenceStats');
  });

  it('fetches the connection holder, unwrapping boardConnection and falling back to null', async () => {
    const client = createBoardPresenceClient(harness.transport);
    const holder = { userId: 'u1', displayName: 'Climber', avatarUrl: null, lastSentAt: null };
    harness.setExecuteResult({ boardConnection: holder });

    expect(await client.fetchConnection(9)).toEqual(holder);
    expect(harness.executeCalls[0].query).toContain('boardConnection');

    harness.setExecuteResult({});
    expect(await client.fetchConnection(9)).toBeNull();
  });

  it('reports a climb with the boardId, climb and angle, treating a non-true response as not accepted', async () => {
    const client = createBoardPresenceClient(harness.transport);
    const climb = { uuid: 'q1', climb: { uuid: 'c1', name: 'X' } } as unknown as ClimbQueueItemInput;
    harness.setExecuteResult({ reportBoardClimb: true });

    expect(await client.reportClimb(5, climb, 40)).toBe(true);
    expect(harness.executeCalls[0].variables).toEqual({ boardId: 5, climb, angle: 40 });
    expect(harness.executeCalls[0].query).toContain('reportBoardClimb');

    harness.setExecuteResult({ reportBoardClimb: false });
    expect(await client.reportClimb(5, climb, null)).toBe(false);
  });

  it('reports a disconnect, treating a non-true response as not accepted', async () => {
    const client = createBoardPresenceClient(harness.transport);
    harness.setExecuteResult({ reportBoardDisconnect: true });

    expect(await client.reportDisconnect(5)).toBe(true);
    expect(harness.executeCalls[0].variables).toEqual({ boardId: 5 });
    expect(harness.executeCalls[0].query).toContain('reportBoardDisconnect');

    harness.setExecuteResult({ reportBoardDisconnect: false });
    expect(await client.reportDisconnect(5)).toBe(false);
  });

  it('resolves a board for a serial, forwarding the board config args', async () => {
    const client = createBoardPresenceClient(harness.transport);
    const resolved = {
      boardId: 11,
      boardName: 'Garage Wall',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
    };
    harness.setExecuteResult({ resolveBoardForSerial: resolved });

    const args = { serial: 'SERIAL-1', boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' };
    const result = await client.resolveBoardForSerial(args);

    expect(result).toEqual(resolved);
    expect(harness.executeCalls[0].variables).toEqual(args);
    expect(harness.executeCalls[0].query).toContain('resolveBoardForSerial');
  });

  it('resolves a selected named board by uuid', async () => {
    const client = createBoardPresenceClient(harness.transport);
    const resolved = {
      boardId: 13,
      boardName: 'Named Board',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
    };
    harness.setExecuteResult({ resolveBoardForUuid: resolved });

    const result = await client.resolveBoardForUuid({ boardUuid: '11111111-1111-4111-8111-111111111111' });

    expect(result).toEqual(resolved);
    expect(harness.executeCalls[0].variables).toEqual({ boardUuid: '11111111-1111-4111-8111-111111111111' });
    expect(harness.executeCalls[0].query).toContain('resolveBoardForUuid');
  });

  it('resolves a board by config for serial-less boards', async () => {
    const client = createBoardPresenceClient(harness.transport);
    const resolved = {
      boardId: 12,
      boardName: 'MoonBoard 40',
      boardType: 'moonboard',
      layoutId: 1,
      sizeId: 1,
      setIds: '2019',
    };
    harness.setExecuteResult({ resolveBoardForConfig: resolved });

    const args = { boardType: 'moonboard', layoutId: 1, sizeId: 1, setIds: '2019' };
    const result = await client.resolveBoardForConfig(args);

    expect(result).toEqual(resolved);
    expect(harness.executeCalls[0].variables).toEqual(args);
    expect(harness.executeCalls[0].query).toContain('resolveBoardForConfig');
  });

  it('resolves board candidates for a serial (the disambiguation extension)', async () => {
    const client = createBoardPresenceClient(harness.transport);
    const result = { board: null, candidates: [{ boardId: 1 }] };
    harness.setExecuteResult({ resolveBoardCandidatesForSerial: result });

    const args = { serial: 'SHARED', boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2' };
    expect(await client.resolveBoardCandidatesForSerial(args)).toEqual(result);
    expect(harness.executeCalls[0].variables).toEqual(args);
    expect(harness.executeCalls[0].query).toContain('resolveBoardCandidatesForSerial');
  });

  it('chooses a board for a serial after disambiguation', async () => {
    const client = createBoardPresenceClient(harness.transport);
    const resolved = {
      boardId: 77,
      boardName: 'Picked Wall',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
    };
    harness.setExecuteResult({ chooseBoardForSerial: resolved });

    const result = await client.chooseBoardForSerial({ boardId: 77, serial: 'SHARED' });

    expect(result).toEqual(resolved);
    expect(harness.executeCalls[0].variables).toEqual({ boardId: 77, serial: 'SHARED' });
    expect(harness.executeCalls[0].query).toContain('chooseBoardForSerial');
  });
});

describe('createBoardPresenceClient — onReconnect', () => {
  let harness: ReturnType<typeof makeTransport>;

  beforeEach(() => {
    harness = makeTransport();
  });

  it('skips the first connected event and fires on the second (reconnect)', () => {
    const client = createBoardPresenceClient(harness.transport);
    const callback = vi.fn();

    client.onReconnect(callback);
    expect(harness.onConnected).toHaveBeenCalledTimes(1);

    harness.fireConnected();
    expect(callback).not.toHaveBeenCalled();

    harness.fireConnected();
    expect(callback).toHaveBeenCalledTimes(1);

    harness.fireConnected();
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('returns an unsubscribe that stops further callbacks', () => {
    const client = createBoardPresenceClient(harness.transport);
    const callback = vi.fn();

    const unsubscribe = client.onReconnect(callback);
    harness.fireConnected(); // first — skipped
    harness.fireConnected(); // second — fires
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(harness.onConnectedUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('fires a re-registration on its first observed connected once the initial connect has been seen (board switch)', () => {
    // graphql-ws does not replay `connected` to a listener added on an
    // already-open socket, so after a mid-session re-registration (the hook
    // effect re-running on a board switch) the new registration's first
    // observed `connected` is a GENUINE reconnect. The skip-first flag is
    // therefore factory-level (`everConnected`), not per-registration.
    const client = createBoardPresenceClient(harness.transport);
    const firstRegistration = vi.fn();

    const unsubscribeFirst = client.onReconnect(firstRegistration);
    harness.fireConnected(); // initial connect — skipped
    expect(firstRegistration).not.toHaveBeenCalled();

    // Board switch: the old registration tears down, a new one registers on
    // the (still-open) socket, then the socket drops and reconnects.
    unsubscribeFirst();
    const secondRegistration = vi.fn();
    client.onReconnect(secondRegistration);

    harness.fireConnected(); // reconnect — the new registration's FIRST observed event
    expect(secondRegistration).toHaveBeenCalledTimes(1);
    // The unsubscribed registration stays silent.
    expect(firstRegistration).not.toHaveBeenCalled();
  });

  it('two live registrations both fire on a reconnect (shared everConnected)', () => {
    const client = createBoardPresenceClient(harness.transport);
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();

    client.onReconnect(firstCallback);
    harness.fireConnected(); // initial connect — skipped for everyone
    expect(firstCallback).not.toHaveBeenCalled();

    client.onReconnect(secondCallback);
    harness.fireConnected(); // reconnect — both fire (an extra catch-up coalesces safely)
    expect(firstCallback).toHaveBeenCalledTimes(1);
    expect(secondCallback).toHaveBeenCalledTimes(1);
  });

  it('an unsubscribed registration stops receiving reconnects', () => {
    const client = createBoardPresenceClient(harness.transport);
    const callback = vi.fn();

    const unsubscribe = client.onReconnect(callback);
    harness.fireConnected(); // initial — skipped
    harness.fireConnected(); // reconnect — fires
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
    harness.fireConnected();
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
