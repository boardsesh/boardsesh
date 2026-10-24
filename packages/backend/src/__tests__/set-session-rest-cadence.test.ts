/**
 * The `setSessionRestCadence` mutation (#5382): the crew's shared rest clock.
 *
 * The resolver runs against the REAL room manager (its in-memory fallback,
 * reset before every test by setup.ts) so validation, the membership gate, the
 * reducer and the compare-and-set are exercised together. Only pubsub and the
 * two shared gates are mocked, so each test can see exactly what was published
 * and decide whether the caller is a member.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';

vi.mock('../pubsub/index', () => ({
  pubsub: {
    publishSessionEvent: vi.fn(),
    publishQueueEvent: vi.fn(),
  },
}));

vi.mock('../graphql/resolvers/shared/helpers', async () => {
  const actual = await vi.importActual<typeof import('../graphql/resolvers/shared/helpers')>(
    '../graphql/resolvers/shared/helpers',
  );
  return {
    ...actual,
    requireSessionMember: vi.fn().mockResolvedValue(undefined),
    applyRateLimit: vi.fn().mockResolvedValue(undefined),
  };
});

const { sessionMutations } = await import('../graphql/resolvers/sessions/mutations');
const { roomManager } = await import('../services/room-manager');
const { pubsub } = await import('../pubsub/index');
const sharedHelpers = await import('../graphql/resolvers/shared/helpers');
const { restCadenceRevisionFloor } = await import('../services/rest-cadence');

const pubsubMock = pubsub as unknown as { publishSessionEvent: ReturnType<typeof vi.fn> };
const requireSessionMember = sharedHelpers.requireSessionMember as unknown as ReturnType<typeof vi.fn>;
const applyRateLimit = sharedHelpers.applyRateLimit as unknown as ReturnType<typeof vi.fn>;

const NOW = 1_800_000_000_000;
// A first write takes the seconds-since-2026 floor; later writes at the same instant count up from it.
const FIRST_REVISION = restCadenceRevisionFloor(NOW);
const SESSION_ID = 'crew-session-1';
// The session HMAC peers already see as SessionUser.id; it must go out verbatim.
const PARTICIPANT_ID = 'a1b2c3d4e5f6';

const SETTINGS_CONFIG = {
  mode: 'afterTick',
  targetSeconds: 90,
  autoAdvance: true,
  advanceOn: 'deadline',
  source: 'settings',
} as const;

function makeCtx(overrides: Partial<ConnectionContext> = {}): ConnectionContext {
  return {
    connectionId: 'conn-1',
    transport: 'ws',
    sessionId: SESSION_ID,
    participantId: PARTICIPANT_ID,
    userId: undefined,
    isAuthenticated: false,
    ...overrides,
  };
}

const setRestCadence = (input: Record<string, unknown>, ctx: ConnectionContext = makeCtx()) =>
  sessionMutations.setSessionRestCadence(undefined, { input }, ctx);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  pubsubMock.publishSessionEvent.mockClear();
  applyRateLimit.mockClear();
  requireSessionMember.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('setSessionRestCadence', () => {
  it('arms the crew clock with server-stamped instants and publishes the change once', async () => {
    const result = await setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG, elapsedMs: 4_000 });

    expect(result).toEqual({
      applied: true,
      change: {
        __typename: 'SessionRestCadenceChanged',
        restCadence: {
          __typename: 'SessionRestCadence',
          ...SETTINGS_CONFIG,
          isRunning: true,
          anchorAt: String(NOW - 4_000),
          pausedElapsedSeconds: 0,
          lastFiredBeatAt: null,
          lastTickQueueItemUuid: null,
          lastTickStatus: null,
          setByParticipantId: PARTICIPANT_ID,
        },
        revision: FIRST_REVISION,
        serverNow: String(NOW),
        isSnapshot: false,
        action: 'ARM',
      },
    });
    expect(pubsubMock.publishSessionEvent).toHaveBeenCalledOnce();
    expect(pubsubMock.publishSessionEvent).toHaveBeenCalledWith(SESSION_ID, result.change);
  });

  it('spends its own 240/min rate-limit bucket, not the shared session one', async () => {
    await setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG });
    expect(applyRateLimit).toHaveBeenCalledWith(expect.anything(), 240, 'restCadence');
  });

  it.each([
    ['an afterTick rest under 10 s', { action: 'ARM', config: { ...SETTINGS_CONFIG, targetSeconds: 9 } }],
    [
      'an onTheMinute beat under 15 s',
      { action: 'ARM', config: { ...SETTINGS_CONFIG, mode: 'onTheMinute', targetSeconds: 14 } },
    ],
    ['a rest over an hour', { action: 'ARM', config: { ...SETTINGS_CONFIG, targetSeconds: 3601 } }],
    ['an unknown mode', { action: 'ARM', config: { ...SETTINGS_CONFIG, mode: 'everyOtherMinute' } }],
    ['an unknown advance rule', { action: 'ARM', config: { ...SETTINGS_CONFIG, advanceOn: 'beat' } }],
    ['ARM without a config', { action: 'ARM' }],
    ['CONFIGURE without a config', { action: 'CONFIGURE', anchor: 'NOW' }],
    ['TICK without a status', { action: 'TICK', tickQueueItemUuid: 'item-1' }],
    ['a TICK status outside flash/send/attempt', { action: 'TICK', tickStatus: 'project' }],
    ['FIRE without an expected revision', { action: 'FIRE', firedBeatAgoMs: 100 }],
    ['a negative elapsed', { action: 'ARM', config: SETTINGS_CONFIG, elapsedMs: -1 }],
  ])('rejects %s without writing or publishing', async (_label, input) => {
    await expect(setRestCadence(input)).rejects.toThrow(/Invalid input/);
    expect((await roomManager.getSessionRestCadence(SESSION_ID)).revision).toBe(0);
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('accepts the 10 s changeover a workout stage uses between climbs', async () => {
    const result = await setRestCadence({
      action: 'ARM',
      config: { ...SETTINGS_CONFIG, targetSeconds: 10, advanceOn: 'tick', source: 'stage' },
    });
    expect(result.applied).toBe(true);
  });

  it('rejects a non-member before anything is stored', async () => {
    requireSessionMember.mockRejectedValueOnce(new Error('Not a member of this session'));
    await expect(setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG })).rejects.toThrow('Not a member');
    expect(requireSessionMember).toHaveBeenCalledWith(expect.anything(), SESSION_ID);
    expect((await roomManager.getSessionRestCadence(SESSION_ID)).revision).toBe(0);
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('gives a non-member with invalid input the membership error, not the validation one', async () => {
    requireSessionMember.mockRejectedValueOnce(new Error('Not a member of this session'));
    const rejection = setRestCadence({ action: 'ARM', config: { ...SETTINGS_CONFIG, targetSeconds: 9 } });
    await expect(rejection).rejects.toThrow('Not a member');
    await expect(rejection).rejects.not.toThrow(/Invalid input/);
    expect((await roomManager.getSessionRestCadence(SESSION_ID)).revision).toBe(0);
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('stamps serverNow from the same instant as the anchor, even when the store write is slow', async () => {
    const realUpdate = roomManager.updateSessionRestCadence.bind(roomManager);
    const slowStore = vi
      .spyOn(roomManager, 'updateSessionRestCadence')
      .mockImplementationOnce(async (...args: Parameters<typeof realUpdate>) => {
        const commit = await realUpdate(...args);
        // The Redis round trip took 37 ms.
        vi.setSystemTime(NOW + 37);
        return commit;
      });

    try {
      const result = await setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG, elapsedMs: 4_000 });

      expect(slowStore).toHaveBeenCalledWith(SESSION_ID, expect.anything(), PARTICIPANT_ID, NOW);
      expect(result.change.restCadence?.anchorAt).toBe(String(NOW - 4_000));
      expect(result.change.serverNow).toBe(String(NOW));
      expect(pubsubMock.publishSessionEvent).toHaveBeenCalledWith(SESSION_ID, result.change);
    } finally {
      slowStore.mockRestore();
    }
  });

  it('hard-errors without a participant id instead of falling back to the connection id', async () => {
    await expect(
      setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG }, makeCtx({ participantId: undefined })),
    ).rejects.toThrow('requires ctx.participantId');
    expect((await roomManager.getSessionRestCadence(SESSION_ID)).revision).toBe(0);
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('needs a session on the connection', async () => {
    await expect(
      setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG }, makeCtx({ sessionId: undefined })),
    ).rejects.toThrow('Must be in a session');
  });

  it('lets exactly one FIRE claim a beat: the second, on the same revision, does not apply or publish', async () => {
    const armed = await setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG, elapsedMs: 90_000 });
    pubsubMock.publishSessionEvent.mockClear();

    const holder = await setRestCadence({
      action: 'FIRE',
      expectedRevision: armed.change.revision,
      firedBeatAgoMs: 200,
    });
    const otherPhone = await setRestCadence(
      { action: 'FIRE', expectedRevision: armed.change.revision, firedBeatAgoMs: 150 },
      makeCtx({ connectionId: 'conn-2', participantId: 'f6e5d4c3b2a1' }),
    );

    expect(holder.applied).toBe(true);
    expect(holder.change.revision).toBe(FIRST_REVISION + 1);
    // The beat is the deadline the stored clock gives (anchor + 90 s), not the age the phone reported.
    expect(holder.change.restCadence?.lastFiredBeatAt).toBe(String(NOW));
    expect(otherPhone).toEqual({ applied: false, change: { ...holder.change, action: null } });
    expect(pubsubMock.publishSessionEvent).toHaveBeenCalledOnce();
    expect(pubsubMock.publishSessionEvent).toHaveBeenCalledWith(SESSION_ID, holder.change);
  });

  describe('a FIRE claims each beat once (#6724 review)', () => {
    const ON_THE_MINUTE_CONFIG = { ...SETTINGS_CONFIG, mode: 'onTheMinute', targetSeconds: 60 } as const;
    const otherPhone = () => makeCtx({ connectionId: 'conn-2', participantId: 'f6e5d4c3b2a1' });

    it('refuses a second FIRE on the same onTheMinute beat, on the revision the first one returned', async () => {
      // Armed a minute ago on a 60 s beat: the first beat falls due now.
      const armed = await setRestCadence({ action: 'ARM', config: ON_THE_MINUTE_CONFIG, elapsedMs: 60_000 });
      pubsubMock.publishSessionEvent.mockClear();

      const first = await setRestCadence({
        action: 'FIRE',
        expectedRevision: armed.change.revision,
        firedBeatAgoMs: 0,
      });
      vi.setSystemTime(NOW + 100);
      const second = await setRestCadence(
        { action: 'FIRE', expectedRevision: first.change.revision, firedBeatAgoMs: 90 },
        otherPhone(),
      );

      expect(first.applied).toBe(true);
      expect(second.applied).toBe(false);
      expect(second.change).toMatchObject({ revision: first.change.revision, action: null, isSnapshot: false });
      expect(second.change.restCadence).toEqual(first.change.restCadence);
      expect(pubsubMock.publishSessionEvent).toHaveBeenCalledOnce();
      expect(pubsubMock.publishSessionEvent).toHaveBeenCalledWith(SESSION_ID, first.change);
    });

    it('refuses a second afterTick + deadline FIRE on the revision the first one returned', async () => {
      const armed = await setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG, elapsedMs: 90_000 });
      pubsubMock.publishSessionEvent.mockClear();

      const first = await setRestCadence({ action: 'FIRE', expectedRevision: armed.change.revision });
      vi.setSystemTime(NOW + 100);
      const second = await setRestCadence({ action: 'FIRE', expectedRevision: first.change.revision }, otherPhone());

      expect(first.applied).toBe(true);
      expect(second.applied).toBe(false);
      expect(pubsubMock.publishSessionEvent).toHaveBeenCalledOnce();
    });

    it('lets the holder claim the next beat, even a little early by its own clock', async () => {
      const armed = await setRestCadence({ action: 'ARM', config: ON_THE_MINUTE_CONFIG, elapsedMs: 60_000 });
      const first = await setRestCadence({ action: 'FIRE', expectedRevision: armed.change.revision });
      pubsubMock.publishSessionEvent.mockClear();

      // The holder's estimate of the server clock runs 1.5 s fast.
      vi.setSystemTime(NOW + 60_000 - 1_500);
      const nextBeat = await setRestCadence({ action: 'FIRE', expectedRevision: first.change.revision });

      expect(nextBeat.applied).toBe(true);
      expect(nextBeat.change.restCadence?.lastFiredBeatAt).toBe(String(NOW + 60_000));
      expect(pubsubMock.publishSessionEvent).toHaveBeenCalledWith(SESSION_ID, nextBeat.change);
    });

    it('refuses a FIRE before the beat is due, and publishes nothing', async () => {
      const armed = await setRestCadence({ action: 'ARM', config: ON_THE_MINUTE_CONFIG, elapsedMs: 30_000 });
      pubsubMock.publishSessionEvent.mockClear();

      const early = await setRestCadence({ action: 'FIRE', expectedRevision: armed.change.revision });

      expect(early).toEqual({ applied: false, change: { ...armed.change, action: null } });
      expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
    });

    it('applies a FIRE up to 5 s after its beat and refuses one later, publishing nothing', async () => {
      // A 90 s rest that ran out just now.
      const armed = await setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG, elapsedMs: 90_000 });
      pubsubMock.publishSessionEvent.mockClear();

      vi.setSystemTime(NOW + 5_001);
      const tooLate = await setRestCadence({ action: 'FIRE', expectedRevision: armed.change.revision });
      expect(tooLate.applied).toBe(false);
      expect(tooLate.change).toMatchObject({ revision: armed.change.revision, action: null });
      expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();

      vi.setSystemTime(NOW + 5_000);
      const late = await setRestCadence({ action: 'FIRE', expectedRevision: armed.change.revision });
      expect(late.applied).toBe(true);
      expect(late.change.restCadence?.lastFiredBeatAt).toBe(String(NOW));
      expect(pubsubMock.publishSessionEvent).toHaveBeenCalledOnce();
    });
  });

  it('a stale revision comes back with the stored clock so the caller can adopt it', async () => {
    await setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG, elapsedMs: 0 });
    await setRestCadence({ action: 'TICK', tickQueueItemUuid: 'item-1', tickStatus: 'send' });
    pubsubMock.publishSessionEvent.mockClear();

    const stale = await setRestCadence({ action: 'FIRE', expectedRevision: FIRST_REVISION });

    expect(stale.applied).toBe(false);
    expect(stale.change).toMatchObject({
      revision: FIRST_REVISION + 1,
      action: null,
      isSnapshot: false,
      restCadence: { lastTickQueueItemUuid: 'item-1', lastTickStatus: 'send' },
    });
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('an action that does not apply publishes nothing', async () => {
    await setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG });
    await setRestCadence({ action: 'PAUSE', pausedElapsedSeconds: 12 });
    pubsubMock.publishSessionEvent.mockClear();

    const again = await setRestCadence({ action: 'PAUSE', pausedElapsedSeconds: 20 });

    expect(again.applied).toBe(false);
    expect(again.change.restCadence?.pausedElapsedSeconds).toBe(12);
    expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
  });

  it('records who configured the clock verbatim, and a tick from someone else leaves it', async () => {
    await setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG });
    const configured = await setRestCadence(
      { action: 'CONFIGURE', config: { ...SETTINGS_CONFIG, targetSeconds: 180, source: 'stage' }, anchor: 'CLEAR' },
      makeCtx({ participantId: 'builder-phone' }),
    );
    expect(configured.change.restCadence).toMatchObject({
      targetSeconds: 180,
      source: 'stage',
      anchorAt: null,
      setByParticipantId: 'builder-phone',
    });

    const ticked = await setRestCadence({ action: 'TICK', tickStatus: 'attempt' });
    expect(ticked.change.restCadence?.setByParticipantId).toBe('builder-phone');
  });

  describe('a tick logged more than a minute before it landed (#6729 twin)', () => {
    const SEND_RULE = { ...SETTINGS_CONFIG, targetSeconds: 60, advanceOn: 'send', source: 'stage' } as const;
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

    /** Armed under send, sent on item-1, advanced at NOW + 61 s: no anchor, no last tick. */
    async function advancedOnSend() {
      await setRestCadence({ action: 'ARM', config: SEND_RULE, elapsedMs: 0 });
      vi.setSystemTime(NOW + 1_000);
      await setRestCadence({ action: 'TICK', tickQueueItemUuid: 'item-1', tickStatus: 'send' });
      vi.setSystemTime(NOW + 61_000);
      const before = await roomManager.getSessionRestCadence(SESSION_ID);
      const fired = await setRestCadence({ action: 'FIRE', expectedRevision: before.revision });
      expect(fired.applied).toBe(true);
      expect(fired.change.restCadence).toMatchObject({ anchorAt: null, lastTickStatus: null });
    }

    it('writes and publishes nothing for a tick older than any rest, so the FIRE it would have earned is refused', async () => {
      await advancedOnSend();
      const stored = await roomManager.getSessionRestCadence(SESSION_ID);
      pubsubMock.publishSessionEvent.mockClear();
      vi.setSystemTime(NOW + 63_000);
      const ticked = await setRestCadence({
        action: 'TICK',
        tickQueueItemUuid: 'item-2',
        tickStatus: 'send',
        elapsedMs: FOUR_HOURS_MS,
      });
      // Before: applied, anchored on the advance with lastTick item-2, and the FIRE at NOW + 121 s applied.
      expect(ticked.applied).toBe(false);
      expect(ticked.change.restCadence).toMatchObject({ anchorAt: null, lastTickQueueItemUuid: null });
      expect(await roomManager.getSessionRestCadence(SESSION_ID)).toEqual(stored);
      expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();

      vi.setSystemTime(NOW + 121_000);
      const refused = await setRestCadence({ action: 'FIRE', expectedRevision: ticked.change.revision });
      expect(refused.applied).toBe(false);
      expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();

      // A send logged now earns it.
      const sentNow = await setRestCadence({ action: 'TICK', tickQueueItemUuid: 'item-2', tickStatus: 'send' });
      expect(sentNow.change.restCadence).toMatchObject({ lastTickQueueItemUuid: 'item-2', lastTickStatus: 'send' });
      vi.setSystemTime(NOW + 181_000);
      const fired = await setRestCadence({ action: 'FIRE', expectedRevision: sentNow.change.revision });
      expect(fired.applied).toBe(true);
    });

    it('starts the rest from the advance for a tick inside any rest, without the tick it would need', async () => {
      await advancedOnSend();
      vi.setSystemTime(NOW + 63_000);
      const ticked = await setRestCadence({
        action: 'TICK',
        tickQueueItemUuid: 'item-2',
        tickStatus: 'send',
        elapsedMs: 30 * 60_000,
      });
      expect(ticked.applied).toBe(true);
      expect(ticked.change.restCadence).toMatchObject({ anchorAt: String(NOW + 61_000), lastTickStatus: null });
      vi.setSystemTime(NOW + 121_000);
      const refused = await setRestCadence({ action: 'FIRE', expectedRevision: ticked.change.revision });
      expect(refused.applied).toBe(false);
    });

    it('rejects an elapsed past 4 h without writing, so a client caps the age it sends there', async () => {
      await advancedOnSend();
      const stored = await roomManager.getSessionRestCadence(SESSION_ID);
      pubsubMock.publishSessionEvent.mockClear();
      await expect(
        setRestCadence({
          action: 'TICK',
          tickQueueItemUuid: 'item-2',
          tickStatus: 'send',
          elapsedMs: FOUR_HOURS_MS + 1,
        }),
      ).rejects.toThrow(/Invalid input/);
      expect(await roomManager.getSessionRestCadence(SESSION_ID)).toEqual(stored);
      expect(pubsubMock.publishSessionEvent).not.toHaveBeenCalled();
    });
  });

  it('DISARM turns the clock off for everyone and keeps the revision climbing', async () => {
    await setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG });
    const off = await setRestCadence({ action: 'DISARM' });
    expect(off.change).toMatchObject({ restCadence: null, revision: FIRST_REVISION + 1, action: 'DISARM' });

    const rearmed = await setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG });
    expect(rearmed.change.revision).toBe(FIRST_REVISION + 2);
  });

  describe('after the store lost state (#5382 review)', () => {
    /** Drop the clock's stored state, as a Redis restart or an expired hash would. */
    const loseStoredState = () => roomManager.reset();

    it('sends the stored clock to the whole crew as a snapshot when a FIRE is ahead of the store', async () => {
      const armed = await setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG, elapsedMs: 90_000 });
      loseStoredState();
      const rearmed = await setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG, elapsedMs: 90_000 });
      pubsubMock.publishSessionEvent.mockClear();

      // The holder saw a burst of writes the seconds floor has not caught up with yet.
      const held = armed.change.revision + 40;
      const fire = await setRestCadence({ action: 'FIRE', expectedRevision: held, firedBeatAgoMs: 0 });

      expect(fire.applied).toBe(false);
      expect(fire.change).toMatchObject({
        revision: rearmed.change.revision,
        isSnapshot: true,
        action: null,
        restCadence: { lastFiredBeatAt: null },
      });
      expect(pubsubMock.publishSessionEvent).toHaveBeenCalledOnce();
      expect(pubsubMock.publishSessionEvent).toHaveBeenCalledWith(SESSION_ID, fire.change);
      // The holder adopts the snapshot and claims the next beat on the stored revision.
      const retry = await setRestCadence({ action: 'FIRE', expectedRevision: fire.change.revision });
      expect(retry.applied).toBe(true);
    });

    it('sends a snapshot of "off" when the clock itself was lost', async () => {
      const armed = await setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG, elapsedMs: 90_000 });
      loseStoredState();
      pubsubMock.publishSessionEvent.mockClear();

      const fire = await setRestCadence({ action: 'FIRE', expectedRevision: armed.change.revision });

      expect(fire).toEqual({
        applied: false,
        change: expect.objectContaining({ restCadence: null, revision: 0, isSnapshot: true, action: null }),
      });
      expect(pubsubMock.publishSessionEvent).toHaveBeenCalledWith(SESSION_ID, fire.change);
    });

    it('a write after the loss still climbs past what the crew holds, so nobody drops it', async () => {
      await setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG });
      const held = (await setRestCadence({ action: 'TICK', tickStatus: 'send' })).change.revision;
      loseStoredState();
      vi.setSystemTime(NOW + 3_000);

      const rearmed = await setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG });

      expect(rearmed.change.revision).toBeGreaterThan(held);
      expect(rearmed.change.isSnapshot).toBe(false);
    });

    it('an un-fenced call never publishes a snapshot', async () => {
      await setRestCadence({ action: 'ARM', config: SETTINGS_CONFIG });
      pubsubMock.publishSessionEvent.mockClear();

      const paused = await setRestCadence({ action: 'PAUSE' });

      expect(paused.change.isSnapshot).toBe(false);
      expect(pubsubMock.publishSessionEvent).toHaveBeenCalledWith(SESSION_ID, paused.change);
    });
  });
});
