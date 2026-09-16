import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ClimbStatsEvent, ConnectionContext } from '@boardsesh/shared-schema';

const { subscribeMock, subscriptionState, sprayGate } = vi.hoisted(() => ({
  subscribeMock: vi.fn(),
  subscriptionState: { push: null as ((event: ClimbStatsEvent) => void) | null, unsubscribe: vi.fn() },
  // The spray wall's visibility answer, and how many times the stream asked for it.
  sprayGate: { readable: true, calls: 0 },
}));

vi.mock('../pubsub/index', () => ({
  pubsub: {
    subscribeClimbStats: subscribeMock,
  },
}));

// Stubbed rather than driven through a real wall: the property under test is that
// the STREAM re-asks per event and ends on a no, not what the rule answers — that
// lives in `spray-wall-api.test.ts` against real rows. The gate is null for every
// non-spray board, which is what keeps the kilter tests below free of it.
vi.mock('../graphql/resolvers/climbs/spray-read-access', () => ({
  assertSprayBoardIsReadable: vi.fn(async () => undefined),
  sprayStreamGate: (boardType: string) =>
    boardType === 'spray'
      ? async () => {
          sprayGate.calls += 1;
          return sprayGate.readable;
        }
      : null,
}));

import { climbStatsSubscriptions } from '../graphql/resolvers/ticks/climb-stats-subscriptions';
import {
  acquireClimbStatsSubscription,
  getClimbStatsSubscriptionCount,
  MAX_CLIMB_STATS_SUBSCRIPTIONS_PER_CONNECTION,
  releaseClimbStatsSubscription,
  resetClimbStatsSubscriptionCountsForTests,
} from '../graphql/resolvers/ticks/climb-stats-subscription-counter';

function context(authenticated = true): ConnectionContext {
  return {
    isAuthenticated: authenticated,
    connectionId: 'connection-1',
  } as ConnectionContext;
}

const event: ClimbStatsEvent = {
  boardType: 'kilter',
  layoutId: 1,
  climbUuid: 'climb-1',
  angle: 40,
  ascensionistCount: 3,
  qualityAverage: 3,
  difficultyAverage: 18,
  displayDifficulty: 18,
  difficulty: '6b/V4',
  faUsername: null,
  faAt: null,
  syncSeq: '7',
};

describe('climbStatsUpdated subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetClimbStatsSubscriptionCountsForTests();
    subscriptionState.push = null;
    sprayGate.readable = true;
    sprayGate.calls = 0;
    subscribeMock.mockImplementation(async (_channelKey: string, push: (payload: ClimbStatsEvent) => void) => {
      subscriptionState.push = push;
      return subscriptionState.unsubscribe;
    });
  });

  it('requires authentication and validates the board/layout before subscribing', async () => {
    await expect(
      climbStatsSubscriptions.climbStatsUpdated.subscribe(
        undefined,
        { boardType: 'kilter', layoutId: 1 },
        context(false),
      ),
    ).rejects.toThrow('Authentication required');

    await expect(
      climbStatsSubscriptions.climbStatsUpdated.subscribe(
        undefined,
        { boardType: 'notaboard', layoutId: 1 },
        context(),
      ),
    ).rejects.toThrow('Invalid board type');

    await expect(
      climbStatsSubscriptions.climbStatsUpdated.subscribe(undefined, { boardType: 'kilter', layoutId: 0 }, context()),
    ).rejects.toThrow('Invalid layout id');
    expect(subscribeMock).not.toHaveBeenCalled();
    expect(getClimbStatsSubscriptionCount('connection-1')).toBe(0);
  });

  it('releases capacity when pubsub setup fails', async () => {
    subscribeMock.mockRejectedValueOnce(new Error('Redis unavailable'));

    await expect(
      climbStatsSubscriptions.climbStatsUpdated.subscribe(undefined, { boardType: 'kilter', layoutId: 1 }, context()),
    ).rejects.toThrow('Redis unavailable');

    expect(getClimbStatsSubscriptionCount('connection-1')).toBe(0);
    expect(subscriptionState.unsubscribe).not.toHaveBeenCalled();
  });

  it('subscribes to the canonical layout channel and maps events', async () => {
    const iterator = await climbStatsSubscriptions.climbStatsUpdated.subscribe(
      undefined,
      { boardType: 'kilter', layoutId: 1 },
      context(),
    );
    const next = iterator.next();
    expect(subscribeMock).toHaveBeenCalledWith('kilter:1', expect.any(Function));
    expect(getClimbStatsSubscriptionCount('connection-1')).toBe(1);
    subscriptionState.push?.(event);
    await expect(next).resolves.toEqual({ done: false, value: { climbStatsUpdated: event } });

    await iterator.return?.(undefined);
    expect(subscriptionState.unsubscribe).toHaveBeenCalledTimes(1);
    expect(getClimbStatsSubscriptionCount('connection-1')).toBe(0);
  });

  it('completes an idle pending read immediately when graphql-ws returns the iterator', async () => {
    const iterator = await climbStatsSubscriptions.climbStatsUpdated.subscribe(
      undefined,
      { boardType: 'kilter', layoutId: 1 },
      context(),
    );
    const pendingNext = iterator.next();
    expect(getClimbStatsSubscriptionCount('connection-1')).toBe(1);

    const completion = iterator.return();
    expect(subscriptionState.unsubscribe).toHaveBeenCalledTimes(1);
    expect(getClimbStatsSubscriptionCount('connection-1')).toBe(0);
    await expect(pendingNext).resolves.toEqual({ done: true, value: undefined });
    await expect(completion).resolves.toEqual({ done: true, value: undefined });

    await expect(iterator.return()).resolves.toEqual({ done: true, value: undefined });
    expect(subscriptionState.unsubscribe).toHaveBeenCalledTimes(1);
    expect(getClimbStatsSubscriptionCount('connection-1')).toBe(0);

    subscriptionState.push?.(event);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(subscriptionState.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('never asks the spray gate on a catalogue board', async () => {
    const iterator = await climbStatsSubscriptions.climbStatsUpdated.subscribe(
      undefined,
      { boardType: 'kilter', layoutId: 1 },
      context(),
    );
    const next = iterator.next();
    subscriptionState.push?.(event);
    await expect(next).resolves.toEqual({ done: false, value: { climbStatsUpdated: event } });
    expect(sprayGate.calls).toBe(0);
    await iterator.return?.(undefined);
  });

  it('re-asks a spray wall\u2019s visibility per event, and ends the stream on a no', async () => {
    // Subscribe-time is one answer and a socket outlives it: the owner can take the
    // wall private, or the gym can revoke the membership the answer rested on, and
    // every event on this channel carries the climb uuid, its grade and its ascent
    // count. Ending the iterator is the subscription's empty page — no error, so the
    // client learns nothing about the wall.
    const sprayEvent: ClimbStatsEvent = { ...event, boardType: 'spray', layoutId: 7 };
    const iterator = await climbStatsSubscriptions.climbStatsUpdated.subscribe(
      undefined,
      { boardType: 'spray', layoutId: 7 },
      context(),
    );

    const first = iterator.next();
    subscriptionState.push?.(sprayEvent);
    await expect(first).resolves.toEqual({ done: false, value: { climbStatsUpdated: sprayEvent } });
    expect(sprayGate.calls).toBe(1);

    sprayGate.readable = false;
    const second = iterator.next();
    subscriptionState.push?.(sprayEvent);
    await expect(second).resolves.toEqual({ done: true, value: undefined });

    // …and the connection slot and the pubsub channel go with it, rather than leaking
    // until the client happens to disconnect.
    expect(subscriptionState.unsubscribe).toHaveBeenCalledTimes(1);
    expect(getClimbStatsSubscriptionCount('connection-1')).toBe(0);

    // Closed for good: a later event does not resurrect the stream.
    subscriptionState.push?.(sprayEvent);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('caps subscriptions per connection without leaking rejected capacity', () => {
    for (let index = 0; index < MAX_CLIMB_STATS_SUBSCRIPTIONS_PER_CONNECTION; index += 1) {
      acquireClimbStatsSubscription('connection-1');
    }
    expect(() => acquireClimbStatsSubscription('connection-1')).toThrow('Too many climb-stats subscriptions');
    expect(getClimbStatsSubscriptionCount('connection-1')).toBe(MAX_CLIMB_STATS_SUBSCRIPTIONS_PER_CONNECTION);

    for (let index = 0; index < MAX_CLIMB_STATS_SUBSCRIPTIONS_PER_CONNECTION; index += 1) {
      releaseClimbStatsSubscription('connection-1');
    }
    expect(getClimbStatsSubscriptionCount('connection-1')).toBe(0);
  });
});
