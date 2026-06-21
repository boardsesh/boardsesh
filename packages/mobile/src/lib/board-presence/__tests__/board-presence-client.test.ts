import { describe, it, expect, vi, beforeEach } from 'vitest';
import { boardHistoryCursor } from '@boardsesh/board-presence-react';
import type { Client } from '@boardsesh/graphql-client';
import type { BoardPresenceEvent, ClimbQueueItemInput } from '@boardsesh/shared-schema';

// Stub the shared transport helpers so we can assert the factory wires the right
// operations + variables and unwraps the right response field — without a real
// websocket.
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

vi.mock('@boardsesh/graphql-client', () => ({
  execute: transport.execute,
  subscribe: transport.subscribe,
}));

import { createMobileBoardPresenceClient } from '../board-presence-client';

const fakeClient = { id: 'ws-client' } as unknown as Client;
const getClient = () => fakeClient;

function makeClimb(climbUuid: string) {
  return { climbUuid, seq: 1, sentAt: '2026-06-09T00:00:00.000Z', name: `Climb ${climbUuid}`, angle: 40 };
}

describe('createMobileBoardPresenceClient', () => {
  beforeEach(() => {
    transport.execute.mockReset();
    transport.subscribe.mockReset();
    transport.subscribe.mockReturnValue(vi.fn());
  });

  it('subscribes to BOARD_NOW_PLAYING and forwards set events to the callback', () => {
    const client = createMobileBoardPresenceClient(getClient);
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

    expect(typeof unsubscribe).toBe('function');
  });

  it('does not forward an empty now-playing payload', () => {
    const client = createMobileBoardPresenceClient(getClient);
    const onEvent = vi.fn();
    client.subscribeNowPlaying(1, onEvent);
    const sink = transport.subscribe.mock.calls[0][2];
    sink.next({});
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('fetches recent climbs and unwraps the boardRecentClimbs field', async () => {
    const recent = [makeClimb('c2'), makeClimb('c3')];
    transport.execute.mockResolvedValue({ boardRecentClimbs: recent });

    const climbs = await createMobileBoardPresenceClient(getClient).fetchRecentClimbs(7);

    expect(climbs).toEqual(recent);
    const [passedClient, operation] = transport.execute.mock.calls[0];
    expect(passedClient).toBe(fakeClient);
    expect(operation.variables).toEqual({ boardId: 7 });
    expect(operation.query).toContain('boardRecentClimbs');
  });

  it('falls back to an empty array when boardRecentClimbs is missing', async () => {
    transport.execute.mockResolvedValue({});
    const climbs = await createMobileBoardPresenceClient(getClient).fetchRecentClimbs(7);
    expect(climbs).toEqual([]);
  });

  it('fetches durable history, forwarding limit + before and unwrapping boardHistory', async () => {
    const history = [makeClimb('h1'), makeClimb('h2')];
    transport.execute.mockResolvedValue({ boardHistory: history });

    const climbs = await createMobileBoardPresenceClient(getClient).fetchHistory(7, {
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
    await createMobileBoardPresenceClient(getClient).fetchHistory(7);
    expect(transport.execute.mock.calls[0][1].variables).toEqual({ boardId: 7, limit: null, before: null });
  });

  it('falls back to an empty array when boardHistory is missing', async () => {
    transport.execute.mockResolvedValue({});
    const climbs = await createMobileBoardPresenceClient(getClient).fetchHistory(7);
    expect(climbs).toEqual([]);
  });

  it('fetches stats and unwraps the boardPresenceStats field', async () => {
    const stats = {
      climbsSentCount: 3,
      distinctClimbersCount: 2,
      hardestGrade: 'V7',
      hardestSend: {
        climbUuid: 'c7',
        name: 'Hard Thing',
        grade: 'V7',
        sentByUserId: 'user-1',
        sentByDisplayName: 'Mina',
        sentByAvatarUrl: 'https://example.com/mina.jpg',
        sentAt: '2026-06-09T00:00:00.000Z',
      },
      topGrade: 'V4',
      lastSentAt: null,
    };
    transport.execute.mockResolvedValue({ boardPresenceStats: stats });

    const result = await createMobileBoardPresenceClient(getClient).fetchStats(9);

    expect(result).toEqual(stats);
    expect(transport.execute.mock.calls[0][1].variables).toEqual({ boardId: 9 });
  });

  it('reports a climb with the boardId, climb and angle, returning the accepted flag', async () => {
    transport.execute.mockResolvedValue({ reportBoardClimb: true });
    const climb = { uuid: 'q1', climb: { uuid: 'c1', name: 'X' } } as unknown as ClimbQueueItemInput;

    const accepted = await createMobileBoardPresenceClient(getClient).reportClimb(5, climb, 40);

    expect(accepted).toBe(true);
    const [, operation] = transport.execute.mock.calls[0];
    expect(operation.variables).toEqual({ boardId: 5, climb, angle: 40 });
    expect(operation.query).toContain('reportBoardClimb');
  });

  it('treats a non-true reportBoardClimb response as not accepted', async () => {
    transport.execute.mockResolvedValue({ reportBoardClimb: false });
    const accepted = await createMobileBoardPresenceClient(getClient).reportClimb(
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

    const result = await createMobileBoardPresenceClient(getClient).resolveBoardForSerial({
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

  it('resolves a selected named board by uuid', async () => {
    const resolved = {
      boardId: 13,
      boardName: 'Named Board',
      boardType: 'kilter',
      layoutId: 1,
      sizeId: 10,
      setIds: '1,2',
    };
    transport.execute.mockResolvedValue({ resolveBoardForUuid: resolved });

    const result = await createMobileBoardPresenceClient(getClient).resolveBoardForUuid?.({
      boardUuid: '11111111-1111-4111-8111-111111111111',
    });

    expect(result).toEqual(resolved);
    const [, operation] = transport.execute.mock.calls[0];
    expect(operation.variables).toEqual({
      boardUuid: '11111111-1111-4111-8111-111111111111',
    });
    expect(operation.query).toContain('resolveBoardForUuid');
  });

  it('resolves a board by config for serial-less boards', async () => {
    const resolved = {
      boardId: 12,
      boardName: 'MoonBoard 40',
      boardType: 'moonboard',
      layoutId: 1,
      sizeId: 1,
      setIds: '2019',
    };
    transport.execute.mockResolvedValue({ resolveBoardForConfig: resolved });

    const result = await createMobileBoardPresenceClient(getClient).resolveBoardForConfig?.({
      boardType: 'moonboard',
      layoutId: 1,
      sizeId: 1,
      setIds: '2019',
    });

    expect(result).toEqual(resolved);
    const [, operation] = transport.execute.mock.calls[0];
    expect(operation.variables).toEqual({
      boardType: 'moonboard',
      layoutId: 1,
      sizeId: 1,
      setIds: '2019',
    });
    expect(operation.query).toContain('resolveBoardForConfig');
  });
});
