// What the kiosk supervisor is actually FOR: the state of the wall after it
// acts, not the count of clients it built.
//
// These cases run the REAL `BoardPresenceProvider`, the REAL
// `createReadOnlyWebBoardPresenceClient` and the REAL `KioskBoardFeedBridge`
// over a fake graphql-ws transport, because every one of the failures below
// lives in the seam BETWEEN them:
//
//  - Rebuilding the client is a new client IDENTITY, which makes the shared
//    `useBoardPresence` RESET the wall and re-run its backfill seeds — while
//    the backend is unreachable, which is the only reason a rebuild happens.
//    The seeds swallow their failure, and the presence factory skips a fresh
//    client's first `connected` as "initial connect", so nothing refills the
//    screen afterwards.
//  - graphql-ws never retries an operation the server rejected with a GraphQL
//    error, and a multi-board TV keeps the socket alive on its other boards —
//    so one dead slot emits no `closed` at all.
//
// A passthrough-provider harness (see kiosk-presence-hub.test.tsx) cannot see
// either one.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { render, act } from '@testing-library/react';
import React from 'react';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';

type SocketEvent = 'connected' | 'closed';
type FakeClient = {
  on: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  emit: (event: SocketEvent) => void;
};
type Sink = { next: (data: unknown) => void; error: (err: unknown) => void; complete: () => void };

const createdClients: FakeClient[] = [];
const executedOperations: string[] = [];
const subscribedBoardIds: number[] = [];
const liveSinks = new Map<number, Sink>();
/** Boards whose subscribe the backend rejects per-operation, every time. */
const permanentlyRejectedBoardIds = new Set<number>();
let backendUp = true;

const WALL_CLIMB: BoardPresenceClimb = {
  climbUuid: 'climb-42',
  name: 'Test Problem',
  sentAt: '2026-08-19T10:00:00.000Z',
  seq: 42,
};

function operationName(query: string): string {
  const match = /(query|subscription|mutation)\s+(\w+)/.exec(query);
  return match === null ? 'unknown' : match[2];
}

vi.mock('@/app/lib/realtime/graphql-client', () => ({
  createGraphQLClient: () => {
    const handlers: Record<SocketEvent, Array<() => void>> = { connected: [], closed: [] };
    const client: FakeClient = {
      on: vi.fn((event: SocketEvent, handler: () => void) => {
        handlers[event].push(handler);
        return () => {
          handlers[event] = handlers[event].filter((registered) => registered !== handler);
        };
      }),
      dispose: vi.fn(async () => {}),
      terminate: vi.fn(() => {}),
      emit: (event: SocketEvent) => {
        // Hold the array reference: unsubscribing REPLACES handlers[event], so
        // an off() during dispatch can't mutate what we're iterating.
        const registered = handlers[event];
        for (const handler of registered) handler();
      },
    };
    createdClients.push(client);
    return client;
  },
  execute: vi.fn(async (_client: unknown, operation: { query: string }) => {
    const name = operationName(operation.query);
    executedOperations.push(name);
    if (!backendUp) throw new Error('backend unreachable');
    if (name === 'BoardRecentClimbs') return { boardRecentClimbs: [WALL_CLIMB] };
    if (name === 'BoardPresenceStats') return { boardPresenceStats: { totalSends: 42 } };
    if (name === 'BoardConnection') return { boardConnection: null };
    return {};
  }),
  subscribe: vi.fn((_client: unknown, operation: { variables?: { boardId?: number } }, sink: Sink) => {
    const boardId = operation.variables?.boardId ?? 0;
    subscribedBoardIds.push(boardId);
    liveSinks.set(boardId, sink);
    if (permanentlyRejectedBoardIds.has(boardId)) {
      // A per-operation GraphQL error (rate limit, visibility gate). graphql-ws
      // reports it once and never retries; the socket stays up.
      queueMicrotask(() => sink.error(new Error('RATE_LIMITED')));
    }
    return () => {};
  }),
}));

vi.mock('@/app/lib/backend-url', () => ({ getBackendWsUrl: () => 'ws://backend.test/graphql' }));

const wallByBoardId: Record<number, { climb: string | null; historyLength: number; isLive: boolean }> = {};

// The REAL bridge stays mounted — it is what turns the hub's `catchUpNonce`
// into a catch-up. This wrapper only reads the same contexts a board slot does.
vi.mock('@/app/components/kiosk/kiosk-reliability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/components/kiosk/kiosk-reliability')>();
  const presence = await import('@boardsesh/board-presence-react');
  const RealBridge = actual.KioskBoardFeedBridge;
  return {
    ...actual,
    KioskBoardFeedBridge: (props: React.ComponentProps<typeof actual.KioskBoardFeedBridge>) => {
      const { currentClimb, isLive } = presence.useBoardPresenceCurrent();
      const { history } = presence.useBoardPresenceFeed();
      wallByBoardId[props.boardId] = {
        climb: currentClimb?.name ?? null,
        historyLength: history.length,
        isLive,
      };
      return <RealBridge {...props} />;
    },
  };
});

import KioskPresenceHub, { MAX_STALE_SUBSCRIPTION_REBUILDS, PRESENCE_REBUILD_AFTER_MS } from '../kiosk-presence-hub';

async function settle() {
  await act(async () => {
    for (let tick = 0; tick < 6; tick++) await Promise.resolve();
  });
}

async function advancePastRebuildWindow() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PRESENCE_REBUILD_AFTER_MS + 1_000);
  });
  await settle();
}

describe('kiosk wall recovery', () => {
  beforeEach(() => {
    createdClients.length = 0;
    executedOperations.length = 0;
    subscribedBoardIds.length = 0;
    liveSinks.clear();
    permanentlyRejectedBoardIds.clear();
    for (const boardId of Object.keys(wallByBoardId)) delete wallByBoardId[Number(boardId)];
    backendUp = true;
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('brings the wall back after an outage long enough to force a rebuild', async () => {
    render(
      <KioskPresenceHub boardIds={[7]}>
        <div>kiosk</div>
      </KioskPresenceHub>,
    );
    await settle();
    act(() => createdClients[0].emit('connected'));
    await settle();
    expect(wallByBoardId[7]).toEqual({ climb: 'Test Problem', historyLength: 1, isLive: true });

    // Backend goes away for longer than graphql-ws's whole retry budget: the
    // socket closes and this board's subscription is terminally errored.
    backendUp = false;
    act(() => {
      createdClients[0].emit('closed');
      liveSinks.get(7)?.error(new Error('retry budget exhausted'));
    });
    await settle();

    await advancePastRebuildWindow();
    expect(createdClients).toHaveLength(2);

    // Backend returns and the REBUILT client connects for the first time.
    backendUp = true;
    executedOperations.length = 0;
    act(() => createdClients[1].emit('connected'));
    await settle();

    // The wall is populated again — not merely "live with nothing on it".
    expect(wallByBoardId[7]).toEqual({ climb: 'Test Problem', historyLength: 1, isLive: true });
    expect(executedOperations).toContain('BoardRecentClimbs');
  });

  it('re-subscribes a board whose own subscription died on a healthy socket', async () => {
    render(
      <KioskPresenceHub boardIds={[7, 8]}>
        <div>kiosk</div>
      </KioskPresenceHub>,
    );
    await settle();
    act(() => createdClients[0].emit('connected'));
    await settle();

    // Board 8 alone is rejected. Board 7 keeps streaming, so the socket never
    // closes and nothing else in the stack can notice.
    act(() => liveSinks.get(8)?.error(new Error('RATE_LIMITED')));
    await settle();
    expect(wallByBoardId[8].isLive).toBe(false);
    expect(wallByBoardId[7].isLive).toBe(true);

    await advancePastRebuildWindow();
    act(() => createdClients[1].emit('connected'));
    await settle();

    expect(subscribedBoardIds.filter((boardId) => boardId === 8)).toHaveLength(2);
    expect(wallByBoardId[8].isLive).toBe(true);
    expect(wallByBoardId[8].climb).toBe('Test Problem');
  });

  it('stops rebuilding for a board the backend will never serve again', async () => {
    // A board flipped private mid-session: every re-subscribe is rejected. Left
    // unbounded this would churn the whole client — blanking every other board
    // for a round trip — every five minutes until the 04:00 reload.
    permanentlyRejectedBoardIds.add(8);
    render(
      <KioskPresenceHub boardIds={[7, 8]}>
        <div>kiosk</div>
      </KioskPresenceHub>,
    );
    await settle();
    act(() => createdClients[0].emit('connected'));
    await settle();

    for (let attempt = 0; attempt < MAX_STALE_SUBSCRIPTION_REBUILDS + 3; attempt++) {
      await advancePastRebuildWindow();
      const latestClient = createdClients[createdClients.length - 1];
      act(() => latestClient.emit('connected'));
      await settle();
    }

    expect(createdClients).toHaveLength(MAX_STALE_SUBSCRIPTION_REBUILDS + 1);
    // The healthy board is still streaming on the client it settled on.
    expect(wallByBoardId[7].isLive).toBe(true);
  });
});
