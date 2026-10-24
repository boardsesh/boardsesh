import { describe, expect, it } from 'vite-plus/test';
import {
  REST_CADENCE_CAS_ATTEMPTS,
  applyRestCadenceAction,
  buildRestCadenceChange,
  commitRestCadenceAction,
  parseRestCadence,
  sameRestCadence,
  serializeRestCadence,
  toWireRestCadence,
  type RestCadenceConfig,
  type RestCadenceInput,
  type RestCadenceReduction,
  type RestCadenceState,
  type RestCadenceStore,
  type StoredRestCadence,
} from '../rest-cadence';

const NOW = 1_800_000_000_000;
const ME = 'participant-me';
const PEER = 'participant-peer';

const AFTER_TICK: RestCadenceConfig = {
  mode: 'afterTick',
  targetSeconds: 90,
  autoAdvance: true,
  advanceOn: 'deadline',
  source: 'settings',
};
const ON_THE_MINUTE: RestCadenceConfig = {
  mode: 'onTheMinute',
  targetSeconds: 60,
  autoAdvance: true,
  advanceOn: 'deadline',
  source: 'stage',
};

function clock(overrides: Partial<RestCadenceState> = {}): RestCadenceState {
  return {
    ...AFTER_TICK,
    isRunning: true,
    anchorMs: NOW - 30_000,
    pausedElapsedSeconds: 0,
    lastFiredBeatMs: null,
    lastTick: null,
    setByParticipantId: PEER,
    ...overrides,
  };
}

function next(reduction: RestCadenceReduction): RestCadenceState | null {
  if (!reduction.applicable) throw new Error('expected the action to apply');
  return reduction.next;
}

const reduce = (previous: RestCadenceState | null, input: RestCadenceInput, participantId = ME) =>
  applyRestCadenceAction(previous, input, NOW, participantId);

describe('applyRestCadenceAction', () => {
  describe('ARM', () => {
    it('starts a running clock that waits for a tick when no elapsed is sent', () => {
      expect(next(reduce(null, { action: 'ARM', config: AFTER_TICK }))).toEqual({
        ...AFTER_TICK,
        isRunning: true,
        anchorMs: null,
        pausedElapsedSeconds: 0,
        lastFiredBeatMs: null,
        lastTick: null,
        setByParticipantId: ME,
      });
    });

    it('anchors at server now minus the elapsed the arming phone already counted', () => {
      expect(next(reduce(null, { action: 'ARM', config: ON_THE_MINUTE, elapsedMs: 12_000 }))?.anchorMs).toBe(
        NOW - 12_000,
      );
    });

    it('replaces a clock that is already there, forgetting its fired beat and tick', () => {
      const previous = clock({
        lastFiredBeatMs: NOW - 5_000,
        lastTick: { queueItemUuid: 'item-1', status: 'send' },
        isRunning: false,
        pausedElapsedSeconds: 40,
      });
      expect(next(reduce(previous, { action: 'ARM', config: ON_THE_MINUTE, elapsedMs: 0 }))).toMatchObject({
        mode: 'onTheMinute',
        isRunning: true,
        anchorMs: NOW,
        pausedElapsedSeconds: 0,
        lastFiredBeatMs: null,
        lastTick: null,
        setByParticipantId: ME,
      });
    });

    it('does nothing without a config', () => {
      expect(reduce(null, { action: 'ARM' })).toEqual({ applicable: false });
    });
  });

  it('DISARM turns a clock off and is a no-op when it is already off', () => {
    expect(reduce(clock(), { action: 'DISARM' })).toEqual({ applicable: true, next: null });
    expect(reduce(null, { action: 'DISARM' })).toEqual({ applicable: false });
  });

  it.each(['CONFIGURE', 'TICK', 'FIRE', 'PAUSE', 'RESUME', 'RESET'] as const)(
    '%s does nothing when there is no clock',
    (action) => {
      expect(
        reduce(null, { action, config: AFTER_TICK, tickStatus: 'send', expectedRevision: 0, anchor: 'NOW' }),
      ).toEqual({ applicable: false });
    },
  );

  describe('CONFIGURE', () => {
    const stagePacing: RestCadenceConfig = {
      mode: 'afterTick',
      targetSeconds: 180,
      autoAdvance: true,
      advanceOn: 'send',
      source: 'stage',
    };

    it('replaces the config, keeps the anchor by default and records who set it', () => {
      const previous = clock({ lastTick: { queueItemUuid: 'item-1', status: 'attempt' } });
      expect(next(reduce(previous, { action: 'CONFIGURE', config: stagePacing }))).toEqual({
        ...previous,
        ...stagePacing,
        setByParticipantId: ME,
      });
    });

    it('NOW re-anchors at server now minus elapsed and zeroes a pause (an onTheMinute stage boundary)', () => {
      const previous = clock({ isRunning: false, pausedElapsedSeconds: 25 });
      expect(
        next(reduce(previous, { action: 'CONFIGURE', config: ON_THE_MINUTE, anchor: 'NOW', elapsedMs: 2_000 })),
      ).toMatchObject({ mode: 'onTheMinute', anchorMs: NOW - 2_000, pausedElapsedSeconds: 0, isRunning: false });
    });

    it('CLEAR leaves the clock waiting for the next tick (a tick/send stage boundary)', () => {
      expect(
        next(reduce(clock(), { action: 'CONFIGURE', config: stagePacing, anchor: 'CLEAR', elapsedMs: 9_000 })),
      ).toMatchObject({ advanceOn: 'send', anchorMs: null });
    });

    it('does nothing without a config', () => {
      expect(reduce(clock(), { action: 'CONFIGURE', anchor: 'NOW' })).toEqual({ applicable: false });
    });
  });

  describe('TICK', () => {
    it('afterTick re-anchors on the tick and records it', () => {
      expect(
        next(reduce(clock(), { action: 'TICK', tickQueueItemUuid: 'item-2', tickStatus: 'flash', elapsedMs: 1_500 })),
      ).toMatchObject({ anchorMs: NOW - 1_500, lastTick: { queueItemUuid: 'item-2', status: 'flash' } });
    });

    it('afterTick resumes a paused clock, like the phone store does', () => {
      expect(
        next(reduce(clock({ isRunning: false, pausedElapsedSeconds: 12 }), { action: 'TICK', tickStatus: 'send' })),
      ).toMatchObject({ isRunning: true, pausedElapsedSeconds: 0, anchorMs: NOW });
    });

    it('clamps a late tick to a minute ago, so a replayed tick cannot fire an instant advance', () => {
      expect(next(reduce(clock(), { action: 'TICK', tickStatus: 'send', elapsedMs: 3_600_000 }))?.anchorMs).toBe(
        NOW - 60_000,
      );
    });

    it('onTheMinute holds its beat and only starts a clock that has no anchor', () => {
      const beat = clock({ ...ON_THE_MINUTE, anchorMs: NOW - 42_000 });
      expect(next(reduce(beat, { action: 'TICK', tickStatus: 'attempt', elapsedMs: 3_000 }))).toMatchObject({
        anchorMs: NOW - 42_000,
        lastTick: { queueItemUuid: null, status: 'attempt' },
      });
      const waiting = clock({ ...ON_THE_MINUTE, anchorMs: null });
      expect(next(reduce(waiting, { action: 'TICK', tickStatus: 'send', elapsedMs: 3_000 }))?.anchorMs).toBe(
        NOW - 3_000,
      );
    });

    it('needs a status', () => {
      expect(reduce(clock(), { action: 'TICK', tickQueueItemUuid: 'item-2' })).toEqual({ applicable: false });
    });

    it('never changes who set the clock', () => {
      expect(next(reduce(clock(), { action: 'TICK', tickStatus: 'send' }))?.setByParticipantId).toBe(PEER);
    });
  });

  describe('FIRE', () => {
    const fire = (previous: RestCadenceState, firedBeatAgoMs = 0) =>
      reduce(previous, { action: 'FIRE', expectedRevision: 4, firedBeatAgoMs });

    it('afterTick + deadline restarts the rest from the advance', () => {
      expect(next(fire(clock(), 800))).toMatchObject({ anchorMs: NOW, lastFiredBeatMs: NOW - 800 });
    });

    it('onTheMinute keeps its beat', () => {
      const beat = clock({
        ...ON_THE_MINUTE,
        anchorMs: NOW - 60_000,
        lastTick: { queueItemUuid: 'a', status: 'send' },
      });
      expect(next(fire(beat))).toMatchObject({
        anchorMs: NOW - 60_000,
        lastFiredBeatMs: NOW,
        lastTick: { queueItemUuid: 'a', status: 'send' },
      });
    });

    it.each(['tick', 'send'] as const)(
      'afterTick + %s clears the anchor and the tick, so the next climb waits for its own tick',
      (advanceOn) => {
        const staged = clock({ advanceOn, lastTick: { queueItemUuid: 'item-1', status: 'send' } });
        expect(next(fire(staged))).toMatchObject({ anchorMs: null, lastTick: null, lastFiredBeatMs: NOW });
      },
    );

    it('clamps how long ago the beat fell due to a minute', () => {
      expect(next(fire(clock(), 3_600_000))?.lastFiredBeatMs).toBe(NOW - 60_000);
    });

    it.each([
      ['paused', clock({ isRunning: false })],
      ['auto-advance off', clock({ autoAdvance: false })],
      ['the length Off', clock({ targetSeconds: null })],
      ['waiting for a tick', clock({ anchorMs: null })],
    ])('cannot fire a clock that is %s', (_label, previous) => {
      expect(fire(previous)).toEqual({ applicable: false });
    });

    it.each([
      ['tick', null],
      ['send', null],
      ['send', { queueItemUuid: 'item-1', status: 'attempt' }],
    ] as const)('cannot fire under %s without the tick it needs (last tick %j)', (advanceOn, lastTick) => {
      expect(fire(clock({ advanceOn, lastTick }))).toEqual({ applicable: false });
    });

    it.each([
      ['tick', 'attempt'],
      ['send', 'flash'],
      ['send', 'send'],
    ] as const)('fires under %s after a %s', (advanceOn, status) => {
      expect(fire(clock({ advanceOn, lastTick: { queueItemUuid: 'item-1', status } })).applicable).toBe(true);
    });

    it('cannot fire without a revision to compare against', () => {
      expect(reduce(clock(), { action: 'FIRE' })).toEqual({ applicable: false });
    });
  });

  describe('PAUSE / RESUME / RESET', () => {
    it('PAUSE freezes the elapsed the phone reports', () => {
      expect(next(reduce(clock(), { action: 'PAUSE', pausedElapsedSeconds: 31 }))).toMatchObject({
        isRunning: false,
        pausedElapsedSeconds: 31,
      });
    });

    it('PAUSE without an elapsed freezes what the server counted from its anchor', () => {
      expect(next(reduce(clock({ anchorMs: NOW - 45_900 }), { action: 'PAUSE' }))?.pausedElapsedSeconds).toBe(45);
    });

    it('PAUSE on a paused clock and RESUME on a running one do nothing', () => {
      expect(reduce(clock({ isRunning: false }), { action: 'PAUSE' })).toEqual({ applicable: false });
      expect(reduce(clock(), { action: 'RESUME' })).toEqual({ applicable: false });
    });

    it('RESUME carries the frozen elapsed across the pause', () => {
      expect(next(reduce(clock({ isRunning: false, pausedElapsedSeconds: 20 }), { action: 'RESUME' }))).toMatchObject({
        isRunning: true,
        anchorMs: NOW - 20_000,
        pausedElapsedSeconds: 0,
      });
    });

    it('RESET restarts a running clock now and leaves a paused one waiting for a tick', () => {
      expect(next(reduce(clock(), { action: 'RESET' }))).toMatchObject({ isRunning: true, anchorMs: NOW });
      expect(next(reduce(clock({ isRunning: false, pausedElapsedSeconds: 9 }), { action: 'RESET' }))).toMatchObject({
        isRunning: false,
        anchorMs: null,
        pausedElapsedSeconds: 0,
      });
    });

    it('RESET follows the resetting phone when it says whether it runs', () => {
      expect(next(reduce(clock(), { action: 'RESET', isRunning: false }))).toMatchObject({
        isRunning: false,
        anchorMs: null,
      });
    });
  });
});

describe('stored doc codec and wire projection', () => {
  it('round-trips a clock and reads an empty or unreadable doc as off', () => {
    const state = clock({ lastTick: { queueItemUuid: null, status: 'attempt' } });
    expect(parseRestCadence(serializeRestCadence(state))).toEqual(state);
    expect(serializeRestCadence(null)).toBe('');
    expect(parseRestCadence('')).toBeNull();
    expect(parseRestCadence('{not json')).toBeNull();
    expect(parseRestCadence(JSON.stringify({ ...state, mode: 'everyOtherMinute' }))).toBeNull();
  });

  it('compares clocks field by field', () => {
    expect(sameRestCadence(clock(), clock())).toBe(true);
    expect(sameRestCadence(clock(), clock({ lastTick: { queueItemUuid: null, status: 'send' } }))).toBe(false);
    expect(sameRestCadence(null, null)).toBe(true);
    expect(sameRestCadence(clock(), null)).toBe(false);
  });

  it('projects server epoch ms as decimal strings and the tick as two fields', () => {
    expect(
      toWireRestCadence(clock({ lastFiredBeatMs: NOW - 1, lastTick: { queueItemUuid: 'item-1', status: 'flash' } })),
    ).toEqual({
      __typename: 'SessionRestCadence',
      ...AFTER_TICK,
      isRunning: true,
      anchorAt: String(NOW - 30_000),
      pausedElapsedSeconds: 0,
      lastFiredBeatAt: String(NOW - 1),
      lastTickQueueItemUuid: 'item-1',
      lastTickStatus: 'flash',
      setByParticipantId: PEER,
    });
    expect(toWireRestCadence(null)).toBeNull();
  });

  it('builds the change event with the stamped server time', () => {
    expect(
      buildRestCadenceChange({ revision: 0, cadence: null }, { isSnapshot: true, action: null, serverNowMs: NOW }),
    ).toEqual({
      __typename: 'SessionRestCadenceChanged',
      restCadence: null,
      revision: 0,
      serverNow: String(NOW),
      isSnapshot: true,
      action: null,
    });
  });
});

/** An in-memory store whose compare-and-set can be made to lose races on demand. */
function memoryStore(initial: StoredRestCadence, racingWriter?: () => StoredRestCadence | null) {
  let stored = { revision: initial.revision, doc: serializeRestCadence(initial.cadence) };
  const writes: string[] = [];
  const store: RestCadenceStore = {
    read: async () => ({ revision: stored.revision, cadence: parseRestCadence(stored.doc) }),
    compareAndSet: async (expectedRevision, nextDoc) => {
      const raced = racingWriter?.();
      if (raced) stored = { revision: raced.revision, doc: serializeRestCadence(raced.cadence) };
      if (stored.revision !== expectedRevision) return { ok: false, ...stored };
      stored = { revision: stored.revision + 1, doc: nextDoc };
      writes.push(nextDoc);
      return { ok: true, ...stored };
    },
  };
  return { store, writes, current: () => stored };
}

describe('commitRestCadenceAction', () => {
  it('writes the next revision when the action applies', async () => {
    const { store, writes } = memoryStore({ revision: 3, cadence: clock() });
    const commit = await commitRestCadenceAction(store, { action: 'TICK', tickStatus: 'send' }, NOW, ME);
    expect(commit.applied).toBe(true);
    expect(commit.stored.revision).toBe(4);
    expect(commit.stored.cadence?.anchorMs).toBe(NOW);
    expect(writes).toHaveLength(1);
  });

  it('writes nothing for an action that does not apply, or changes nothing', async () => {
    const { store, writes } = memoryStore({ revision: 3, cadence: clock({ isRunning: false }) });
    expect(await commitRestCadenceAction(store, { action: 'PAUSE' }, NOW, ME)).toEqual({
      applied: false,
      stored: { revision: 3, cadence: clock({ isRunning: false }) },
    });
    const unchanged = clock({ setByParticipantId: ME });
    const same = memoryStore({ revision: 7, cadence: unchanged });
    expect(
      (await commitRestCadenceAction(same.store, { action: 'CONFIGURE', config: AFTER_TICK }, NOW, ME)).applied,
    ).toBe(false);
    expect([...writes, ...same.writes]).toEqual([]);
  });

  it('refuses a FIRE whose revision is stale, without writing', async () => {
    const { store, writes } = memoryStore({ revision: 5, cadence: clock() });
    const commit = await commitRestCadenceAction(store, { action: 'FIRE', expectedRevision: 4 }, NOW, ME);
    expect(commit).toEqual({ applied: false, stored: { revision: 5, cadence: clock() } });
    expect(writes).toEqual([]);
  });

  it('a FIRE that loses the race reports the winner and never retries', async () => {
    const winner = clock({ lastFiredBeatMs: NOW - 10, anchorMs: NOW - 10 });
    let raced = false;
    const { store, writes } = memoryStore({ revision: 5, cadence: clock() }, () => {
      if (raced) return null;
      raced = true;
      return { revision: 6, cadence: winner };
    });
    const commit = await commitRestCadenceAction(store, { action: 'FIRE', expectedRevision: 5 }, NOW, ME);
    expect(commit).toEqual({ applied: false, stored: { revision: 6, cadence: winner } });
    expect(writes).toEqual([]);
  });

  it('an un-fenced call re-reads and retries a lost race on the winning state', async () => {
    let races = 0;
    const { store } = memoryStore({ revision: 1, cadence: clock() }, () => {
      if (races >= 2) return null;
      races += 1;
      return { revision: 1 + races, cadence: clock({ isRunning: races % 2 === 0 }) };
    });
    const commit = await commitRestCadenceAction(
      store,
      { action: 'TICK', tickQueueItemUuid: 'item-9', tickStatus: 'flash' },
      NOW,
      ME,
    );
    expect(commit.applied).toBe(true);
    expect(commit.stored.revision).toBe(4);
    expect(commit.stored.cadence?.lastTick).toEqual({ queueItemUuid: 'item-9', status: 'flash' });
  });

  it('gives up after a bounded number of lost races', async () => {
    let revision = 1;
    const { store, writes } = memoryStore({ revision, cadence: clock() }, () => {
      revision += 1;
      return { revision, cadence: clock() };
    });
    const commit = await commitRestCadenceAction(store, { action: 'RESET' }, NOW, ME);
    expect(commit.applied).toBe(false);
    expect(commit.stored.revision).toBe(1 + REST_CADENCE_CAS_ATTEMPTS);
    expect(writes).toEqual([]);
  });
});
