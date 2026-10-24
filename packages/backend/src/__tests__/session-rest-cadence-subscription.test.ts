/**
 * The crew rest clock on `sessionUpdates` (#5382), driven straight through the
 * resolver: the seed's place after the roster, the live branch re-stamping
 * `serverNow` on the delivering instance, and a cadence write that lands while
 * the seed read is still in flight. Pub/sub and the room manager are stubbed so
 * each test controls exactly when an event is published and when the seed read
 * resolves.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext, SessionEvent, SessionUser } from '@boardsesh/shared-schema';
import {
  buildRestCadenceChange,
  type RestCadenceChangedEvent,
  type RestCadenceState,
  type StoredRestCadence,
} from '../services/rest-cadence';

const hooks = vi.hoisted(() => ({
  listeners: new Set<(event: SessionEvent) => void>(),
  readRestCadence: vi.fn(),
}));

vi.mock('../pubsub', () => ({
  pubsub: {
    subscribeSession: async (_sessionId: string, listener: (event: SessionEvent) => void) => {
      hooks.listeners.add(listener);
      return () => {
        hooks.listeners.delete(listener);
      };
    },
  },
}));
vi.mock('../graphql/resolvers/shared/helpers', () => ({ requireSessionMember: async () => {} }));
vi.mock('../services/privacy', () => ({ canAccessResource: async () => true }));
vi.mock('../graphql/resolvers/sessions/live-session-stats', () => ({
  buildSessionStatsUpdatedEvent: async () => null,
}));
vi.mock('../services/room-manager', () => ({
  roomManager: {
    getSessionUsers: async () => [],
    getSessionById: async () => ({ boardPath: '/b/own/40' }),
    getSessionRestCadence: hooks.readRestCadence,
  },
}));
vi.mock('../services/board-session-privacy', () => ({
  projectSessionBoardPath: async (path: string) => path,
  sessionParticipantId: (_sessionId: string, userId: string) => userId,
  sessionEventParticipantId: (_sessionId: string, participantId: string) => participantId,
  redactSessionUsers: async (users: SessionUser[]) => users,
}));

const { sessionSubscriptions } = await import('../graphql/resolvers/sessions/subscriptions');
const { logger } = await import('../utils/logger');

const context = { connectionId: 'passenger', userId: 'passenger', isAuthenticated: true } as ConnectionContext;
const SUBSCRIBED_AT = 1_800_000_000_000;
// The publishing instance's stamp: a delivered event must never carry it.
const PUBLISHER_STAMP_MS = 1;
const REVISION = 32_774_400;

const ARMED: RestCadenceState = {
  mode: 'afterTick',
  targetSeconds: 90,
  autoAdvance: true,
  advanceOn: 'deadline',
  source: 'settings',
  isRunning: true,
  anchorMs: SUBSCRIBED_AT - 30_000,
  pausedElapsedSeconds: 0,
  lastFiredBeatMs: null,
  lastTick: null,
  setByParticipantId: 'holder',
};
const TICKED: RestCadenceState = {
  ...ARMED,
  anchorMs: SUBSCRIBED_AT,
  lastTick: { queueItemUuid: 'item-1', status: 'send' },
};

function published(
  stored: StoredRestCadence,
  { isSnapshot = false, action = 'TICK' }: Partial<Pick<RestCadenceChangedEvent, 'isSnapshot' | 'action'>> = {},
): RestCadenceChangedEvent {
  return buildRestCadenceChange(stored, { isSnapshot, action, serverNowMs: PUBLISHER_STAMP_MS });
}

function publish(event: SessionEvent) {
  for (const listener of hooks.listeners) listener(event);
}

function subscribe() {
  return sessionSubscriptions.sessionUpdates.subscribe(undefined, { sessionId: 'crew' }, context);
}

async function nextEvent(stream: ReturnType<typeof subscribe>) {
  const result = await stream.next();
  if (result.done) throw new Error('Subscription ended before its event');
  return result.value.sessionUpdates;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(SUBSCRIBED_AT);
  hooks.listeners.clear();
  hooks.readRestCadence.mockReset().mockResolvedValue({ revision: REVISION, cadence: ARMED });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sessionUpdates crew rest clock', () => {
  it('stamps a live change with the time this instance delivers it, not the time it was published', async () => {
    const stream = subscribe();
    try {
      expect(await nextEvent(stream)).toMatchObject({ __typename: 'SessionRosterSnapshot' });
      expect(await nextEvent(stream)).toMatchObject({
        __typename: 'SessionRestCadenceChanged',
        revision: REVISION,
        isSnapshot: true,
        serverNow: String(SUBSCRIBED_AT),
      });

      const change = published({ revision: REVISION + 1, cadence: TICKED });
      publish(change);
      // Redis fan-out took 750 ms to reach this instance.
      vi.setSystemTime(SUBSCRIBED_AT + 750);

      expect(await nextEvent(stream)).toEqual({ ...change, serverNow: String(SUBSCRIBED_AT + 750) });
    } finally {
      await stream.return();
    }
  });

  it('keeps a published snapshot a snapshot, so a crew whose store lost state resets its revision floor', async () => {
    const stream = subscribe();
    try {
      await nextEvent(stream);
      await nextEvent(stream);

      const rewound = published({ revision: 3, cadence: ARMED }, { isSnapshot: true, action: null });
      publish(rewound);
      vi.setSystemTime(SUBSCRIBED_AT + 2_000);

      expect(await nextEvent(stream)).toEqual({
        ...rewound,
        isSnapshot: true,
        serverNow: String(SUBSCRIBED_AT + 2_000),
      });
    } finally {
      await stream.return();
    }
  });

  it.each([
    ['before the write committed', { revision: REVISION, cadence: ARMED }],
    ['after the write committed', { revision: REVISION + 1, cadence: TICKED }],
  ])(
    'delivers a write that raced the seed read (read %s) after the seed, never below its revision',
    async (_label, seededState: StoredRestCadence) => {
      let markReadStarted = () => {};
      const readStarted = new Promise<void>((resolve) => {
        markReadStarted = resolve;
      });
      let finishRead: (stored: StoredRestCadence) => void = () => {};
      hooks.readRestCadence.mockImplementation(() => {
        markReadStarted();
        return new Promise<StoredRestCadence>((resolve) => {
          finishRead = resolve;
        });
      });

      const stream = subscribe();
      try {
        const rosterSeed = nextEvent(stream);
        // The channel is subscribed before the seed read starts, so this write is queued, not lost.
        await readStarted;
        const racingWrite = published({ revision: REVISION + 1, cadence: TICKED });
        publish(racingWrite);
        finishRead(seededState);

        expect(await rosterSeed).toMatchObject({ __typename: 'SessionRosterSnapshot' });
        const seed = await nextEvent(stream);
        expect(seed).toMatchObject({
          __typename: 'SessionRestCadenceChanged',
          isSnapshot: true,
          revision: seededState.revision,
        });
        const live = await nextEvent(stream);
        expect(live).toMatchObject({
          __typename: 'SessionRestCadenceChanged',
          isSnapshot: false,
          revision: REVISION + 1,
        });
        if (seed.__typename !== 'SessionRestCadenceChanged' || live.__typename !== 'SessionRestCadenceChanged') {
          throw new Error('expected two rest clock events');
        }
        // A client drops the live copy when it is at or below the seed, and applies it otherwise.
        expect(live.revision).toBeGreaterThanOrEqual(seed.revision);
      } finally {
        await stream.return();
      }
    },
  );

  it('retries a failed clock seed read once, and seeds from the retry', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    hooks.readRestCadence
      .mockReset()
      .mockRejectedValueOnce(new Error('redis blip'))
      .mockResolvedValueOnce({ revision: REVISION, cadence: ARMED });
    const stream = subscribe();
    try {
      expect(await nextEvent(stream)).toMatchObject({ __typename: 'SessionRosterSnapshot' });
      expect(await nextEvent(stream)).toMatchObject({
        __typename: 'SessionRestCadenceChanged',
        revision: REVISION,
        isSnapshot: true,
        action: null,
      });
      expect(hooks.readRestCadence).toHaveBeenCalledTimes(2);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await stream.return();
    }
  });

  it('skips only the clock seed, with a warning, when the retry fails too, and keeps delivering the clock live', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    hooks.readRestCadence.mockReset().mockRejectedValue(new Error('redis unavailable'));
    const stream = subscribe();
    try {
      expect(await nextEvent(stream)).toMatchObject({ __typename: 'SessionRosterSnapshot' });
      expect(hooks.readRestCadence).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('rest cadence seed read failed twice'));

      // No stand-in "off" seed: the next event is the live change.
      const change = published({ revision: REVISION + 1, cadence: TICKED });
      publish(change);

      expect(await nextEvent(stream)).toEqual({ ...change, serverNow: String(SUBSCRIBED_AT) });
    } finally {
      warn.mockRestore();
      await stream.return();
    }
  });
});
