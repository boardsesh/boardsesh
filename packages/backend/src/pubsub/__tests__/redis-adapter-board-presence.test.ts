import type { BoardPresenceEvent } from '@boardsesh/shared-schema';
import type Redis from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { createRedisPubSubAdapter } from '../redis-adapter';

type RedisMessageHandler = (channel: string, message: string) => void;

function createHarness(): {
  adapter: ReturnType<typeof createRedisPubSubAdapter>;
  dispatch: RedisMessageHandler;
} {
  let messageHandler: RedisMessageHandler | undefined;
  const mockPublisher = { publish: vi.fn().mockResolvedValue(1) } as unknown as Redis;
  const mockSubscriber = {
    on: vi.fn((eventName: string, handler: RedisMessageHandler) => {
      if (eventName === 'message') messageHandler = handler;
    }),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
  } as unknown as Redis;
  const adapter = createRedisPubSubAdapter(mockPublisher, mockSubscriber);
  if (messageHandler === undefined) throw new Error('Redis message handler was not registered');
  return { adapter, dispatch: messageHandler };
}

function peerMessage(event: unknown): string {
  return JSON.stringify({ instanceId: 'peer-instance', event, timestamp: 1_788_134_400_000 });
}

describe('Redis board-presence fan-in', () => {
  it('preserves current history, orientation, and privacy provenance fields', () => {
    const { adapter, dispatch } = createHarness();
    const received: BoardPresenceEvent[] = [];
    adapter.onBoardPresenceMessage((_boardId, event) => received.push(event));
    const history: BoardPresenceEvent = {
      __typename: 'BoardHistoryUpdated',
      climbs: [
        {
          climbUuid: 'climb-1',
          source: 'kilter',
          mirrored: true,
          sessionId: 'session-1',
          identityPolicyVersion: 1,
          sentAt: '2026-08-30T00:00:00.000Z',
          seq: 1,
        },
      ],
      seq: 2,
    };
    const clear: BoardPresenceEvent = {
      __typename: 'BoardClimbCleared',
      climbUuid: 'climb-1',
      clearedAt: '2026-08-30T00:00:00.000Z',
      seq: 3,
    };

    dispatch('boardsesh:board:123', peerMessage(history));
    dispatch('boardsesh:board:123', peerMessage(clear));

    expect(received).toEqual([history, clear]);
  });

  it('delivers a validated event whose snapshot is bound to the channel board', () => {
    const { adapter, dispatch } = createHarness();
    const received: Array<{ boardId: string; event: BoardPresenceEvent }> = [];
    adapter.onBoardPresenceMessage((boardId, event) => received.push({ boardId, event }));

    dispatch(
      'boardsesh:board:123',
      peerMessage({
        __typename: 'BoardLayersChanged',
        snapshot: {
          boardId: 123,
          layers: [],
          observedAt: '2026-08-30T00:00:00.000Z',
          stale: false,
          seq: 1,
        },
      }),
    );

    expect(received).toEqual([
      {
        boardId: '123',
        event: {
          __typename: 'BoardLayersChanged',
          snapshot: {
            boardId: 123,
            layers: [],
            observedAt: '2026-08-30T00:00:00.000Z',
            stale: false,
            seq: 1,
          },
        },
      },
    ]);
  });

  it('drops malformed envelopes, malformed events, and cross-board snapshots', () => {
    const { adapter, dispatch } = createHarness();
    const callback = vi.fn();
    adapter.onBoardPresenceMessage(callback);

    dispatch(
      'boardsesh:board:123',
      JSON.stringify({
        instanceId: 7,
        event: { __typename: 'BoardClimbCleared', clearedAt: '2026-08-30T00:00:00.000Z', seq: 1 },
        timestamp: 1_788_134_400_000,
      }),
    );
    dispatch(
      'boardsesh:board:123',
      peerMessage({
        __typename: 'BoardClimbSet',
        climb: {
          climbUuid: 'climb-1',
          angle: 1.5,
          sentAt: '2026-08-30T00:00:00.000Z',
          seq: 1,
        },
      }),
    );
    dispatch(
      'boardsesh:board:123',
      peerMessage({
        __typename: 'BoardLayersChanged',
        snapshot: {
          boardId: 456,
          layers: [],
          observedAt: '2026-08-30T00:00:00.000Z',
          stale: false,
          seq: 1,
        },
      }),
    );

    expect(callback).not.toHaveBeenCalled();
  });
});
