import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { Client } from '@boardsesh/graphql-client';
import { boardHistoryCursor } from '@boardsesh/board-presence-react';
import type { BoardPresenceEvent, ClimbQueueItemInput } from '@boardsesh/shared-schema';

// Stub the shared transport helpers (re-exported by the web graphql-queue
// client) so we can assert the factory wires the right operations + variables
// and unwraps the right response field — without a real websocket.
const transport = vi.hoisted(() => ({
  execute:
    vi.fn<(client: unknown, operation: { query: string; variables?: Record<string, unknown> }) => Promise<unknown>>(),
  subscribe: vi.fn<
    (
      client: unknown,
      operation: { query: string; variables?: Record<string, unknown> },
      sink: { next: (data: unknown) => void; error: (err: unknown) => void; complete: () => void },
    ) => () => void
  >(() => () => {}),
}));

vi.mock('../graphql-client', () => ({
  execute: transport.execute,
  subscribe: transport.subscribe,
}));

import { createWebBoardPresenceClient } from '../board-presence-client';

// A `.on('connected', ...)` recorder — web's `ExtendedClient` supports `.on`
// the same way mobile's graphql-ws `Client` does, so `onReconnect` (derived
// from it) is exercisable here without a real websocket.
const connectedListeners: Array<() => void> = [];
const onUnsubscribe = vi.fn();
const onMock = vi.fn((_event: string, listener: () => void) => {
  connectedListeners.push(listener);
  return onUnsubscribe;
});
const fakeClient = { id: 'ws-client', on: onMock } as unknown as Client;
const getClient = () => fakeClient;
const fireConnected = () => connectedListeners.forEach((listener) => listener());

function makeClimb(climbUuid: string) {
  return { climbUuid, seq: 1, sentAt: '2026-06-09T00:00:00.000Z', name: `Climb ${climbUuid}`, angle: 40 };
}

describe('createWebBoardPresenceClient', () => {
  beforeEach(() => {
    transport.execute.mockReset();
    transport.subscribe.mockReset();
    transport.subscribe.mockReturnValue(vi.fn());
    connectedListeners.length = 0;
    onUnsubscribe.mockClear();
    onMock.mockClear();
  });

  it('subscribes to BOARD_NOW_PLAYING and forwards set events to the callback', () => {
    const client = createWebBoardPresenceClient(getClient);
    const onEvent = vi.fn();
    const onError = vi.fn();
    const onComplete = vi.fn();

    const unsubscribe = client.subscribeNowPlaying(42, onEvent, onError, onComplete);

    expect(transport.subscribe).toHaveBeenCalledTimes(1);
    const [passedClient, operation, sink] = transport.subscribe.mock.calls[0];
    expect(passedClient).toBe(fakeClient);
    expect(operation.variables).toEqual({ boardId: 42 });
    expect(operation.query).toContain('boardNowPlaying');

    const event: BoardPresenceEvent = { __typename: 'BoardClimbSet', climb: makeClimb('c1') };
    sink.next({ boardNowPlaying: event });
    expect(onEvent).toHaveBeenCalledWith(event);

    sink.error(new Error('socket dropped'));
    expect(onError).toHaveBeenCalledWith(new Error('socket dropped'));

    sink.complete();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    expect(typeof unsubscribe).toBe('function');
  });

  it('does not forward an empty now-playing payload', () => {
    const client = createWebBoardPresenceClient(getClient);
    const onEvent = vi.fn();
    client.subscribeNowPlaying(1, onEvent);
    const sink = transport.subscribe.mock.calls[0][2];
    sink.next({});
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('fetches recent climbs and unwraps the boardRecentClimbs field', async () => {
    const recent = [makeClimb('c2'), makeClimb('c3')];
    transport.execute.mockResolvedValue({ boardRecentClimbs: recent });

    const climbs = await createWebBoardPresenceClient(getClient).fetchRecentClimbs(7);

    expect(climbs).toEqual(recent);
    const [passedClient, operation] = transport.execute.mock.calls[0];
    expect(passedClient).toBe(fakeClient);
    expect(operation.variables).toEqual({ boardId: 7 });
    expect(operation.query).toContain('boardRecentClimbs');
  });

  it('falls back to an empty array when boardRecentClimbs is missing', async () => {
    transport.execute.mockResolvedValue({});
    const climbs = await createWebBoardPresenceClient(getClient).fetchRecentClimbs(7);
    expect(climbs).toEqual([]);
  });

  it('fetches stats and unwraps the boardPresenceStats field', async () => {
    const stats = {
      climbsSentCount: 3,
      distinctClimbersCount: 2,
      hardestGrade: 'V7',
      topGrade: 'V4',
      lastSentAt: null,
    };
    transport.execute.mockResolvedValue({ boardPresenceStats: stats });

    const result = await createWebBoardPresenceClient(getClient).fetchStats(9);

    expect(result).toEqual(stats);
    expect(transport.execute.mock.calls[0][1].variables).toEqual({ boardId: 9 });
  });

  it('reports a climb with the boardId, climb and angle, returning the accepted flag', async () => {
    transport.execute.mockResolvedValue({ reportBoardClimb: true });
    const climb = { uuid: 'q1', climb: { uuid: 'c1', name: 'X' } } as unknown as ClimbQueueItemInput;

    const accepted = await createWebBoardPresenceClient(getClient).reportClimb(5, climb, 40);

    expect(accepted).toBe(true);
    const [, operation] = transport.execute.mock.calls[0];
    expect(operation.variables).toEqual({ boardId: 5, climb, angle: 40 });
    expect(operation.query).toContain('reportBoardClimb');
  });

  it('treats a non-true reportBoardClimb response as not accepted', async () => {
    transport.execute.mockResolvedValue({ reportBoardClimb: false });
    const accepted = await createWebBoardPresenceClient(getClient).reportClimb(
      5,
      {} as unknown as ClimbQueueItemInput,
      null,
    );
    expect(accepted).toBe(false);
  });

  it('resolves a board for a serial, forwarding the board config args', async () => {
    const resolved = {
      boardId: 11,
      boardName: 'Garage Wall',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
    };
    transport.execute.mockResolvedValue({ resolveBoardForSerial: resolved });

    const result = await createWebBoardPresenceClient(getClient).resolveBoardForSerial({
      serial: 'SERIAL-1',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
    });

    expect(result).toEqual(resolved);
    const [, operation] = transport.execute.mock.calls[0];
    expect(operation.variables).toEqual({
      serial: 'SERIAL-1',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
    });
    expect(operation.query).toContain('resolveBoardForSerial');
  });

  it('resolves a board for serial-less config fallback', async () => {
    const resolved = {
      boardId: 12,
      boardName: 'MoonBoard 2019',
      boardType: 'moonboard',
      layoutId: 2019,
      sizeId: 1,
      setIds: '1',
    };
    transport.execute.mockResolvedValue({ resolveBoardForConfig: resolved });

    const result = await createWebBoardPresenceClient(getClient).resolveBoardForConfig({
      boardType: 'moonboard',
      layoutId: 2019,
      sizeId: 1,
      setIds: '1',
    });

    expect(result).toEqual(resolved);
    const [, operation] = transport.execute.mock.calls[0];
    expect(operation.variables).toEqual({
      boardType: 'moonboard',
      layoutId: 2019,
      sizeId: 1,
      setIds: '1',
    });
    expect(operation.query).toContain('resolveBoardForConfig');
  });

  it('fetches durable history, forwarding limit + before and unwrapping boardHistory', async () => {
    const history = [makeClimb('h1'), makeClimb('h2')];
    transport.execute.mockResolvedValue({ boardHistory: history });

    const climbs = await createWebBoardPresenceClient(getClient).fetchHistory(7, {
      limit: 25,
      before: boardHistoryCursor(900),
    });

    expect(climbs).toEqual(history);
    const [passedClient, operation] = transport.execute.mock.calls[0];
    expect(passedClient).toBe(fakeClient);
    expect(operation.variables).toEqual({ boardId: 7, limit: 25, before: '900' });
    expect(operation.query).toContain('boardHistory');
  });

  it('defaults history limit + before to null when no paging opts are given', async () => {
    transport.execute.mockResolvedValue({ boardHistory: [] });
    await createWebBoardPresenceClient(getClient).fetchHistory(7);
    expect(transport.execute.mock.calls[0][1].variables).toEqual({ boardId: 7, limit: null, before: null });
  });

  it('fetches the current connection holder, unwrapping boardConnection and falling back to null', async () => {
    const holder = { userId: 'u1', displayName: 'Climber', avatarUrl: null, lastSentAt: null };
    transport.execute.mockResolvedValue({ boardConnection: holder });

    const result = await createWebBoardPresenceClient(getClient).fetchConnection(9);

    expect(result).toEqual(holder);
    expect(transport.execute.mock.calls[0][1].variables).toEqual({ boardId: 9 });
    expect(transport.execute.mock.calls[0][1].query).toContain('boardConnection');

    transport.execute.mockResolvedValue({});
    expect(await createWebBoardPresenceClient(getClient).fetchConnection(9)).toBeNull();
  });

  it('reports a disconnect, treating a non-true response as not accepted', async () => {
    transport.execute.mockResolvedValue({ reportBoardDisconnect: true });

    const accepted = await createWebBoardPresenceClient(getClient).reportDisconnect(5);

    expect(accepted).toBe(true);
    const [, operation] = transport.execute.mock.calls[0];
    expect(operation.variables).toEqual({ boardId: 5 });
    expect(operation.query).toContain('reportBoardDisconnect');
  });

  it('registers onReconnect against the client’s "connected" event, skipping the first connect', () => {
    const callback = vi.fn();
    const unsubscribe = createWebBoardPresenceClient(getClient).onReconnect(callback);

    expect(onMock).toHaveBeenCalledWith('connected', expect.any(Function));

    fireConnected(); // first connect — skipped (initial backfill already covers it)
    expect(callback).not.toHaveBeenCalled();

    fireConnected(); // reconnect — fires
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(onUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
