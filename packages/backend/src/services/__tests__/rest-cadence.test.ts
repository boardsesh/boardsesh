import { describe, expect, it } from 'vite-plus/test';
import {
  REST_CADENCE_CAS_ATTEMPTS,
  REST_CADENCE_FIRE_EARLY_TOLERANCE_MS,
  REST_CADENCE_REVISION_EPOCH_MS,
  applyRestCadenceAction,
  buildRestCadenceChange,
  claimableRestCadenceBeatMs,
  commitRestCadenceAction,
  parseRestCadence,
  restCadenceRevisionFloor,
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
    const fire = (previous: RestCadenceState, firedBeatAgoMs = 0, nowMs = NOW) =>
      applyRestCadenceAction(previous, { action: 'FIRE', expectedRevision: 4, firedBeatAgoMs }, nowMs, ME);
    // A 90 s afterTick rest that started 90 s ago: its deadline is NOW.
    const due = (overrides: Partial<RestCadenceState> = {}) => clock({ anchorMs: NOW - 90_000, ...overrides });
    // A 60 s beat armed a minute ago: its first beat is NOW.
    const beat = (overrides: Partial<RestCadenceState> = {}) =>
      clock({ ...ON_THE_MINUTE, anchorMs: NOW - 60_000, ...overrides });

    it('afterTick + deadline restarts the rest from the advance and records the deadline it claimed', () => {
      expect(next(fire(due()))).toMatchObject({ anchorMs: NOW, lastFiredBeatMs: NOW });
      // Three seconds late: the claimed beat is still the deadline, not the moment the FIRE landed.
      expect(next(fire(due({ anchorMs: NOW - 93_000 })))).toMatchObject({
        anchorMs: NOW,
        lastFiredBeatMs: NOW - 3_000,
      });
    });

    it('onTheMinute keeps its beat', () => {
      expect(next(fire(beat({ lastTick: { queueItemUuid: 'a', status: 'send' } })))).toMatchObject({
        anchorMs: NOW - 60_000,
        lastFiredBeatMs: NOW,
        lastTick: { queueItemUuid: 'a', status: 'send' },
      });
    });

    it('onTheMinute claims the latest beat that is due, skipping the ones nobody fired', () => {
      // Beats at NOW - 140 s, - 80 s and - 20 s.
      expect(next(fire(beat({ anchorMs: NOW - 200_000 })))?.lastFiredBeatMs).toBe(NOW - 20_000);
    });

    it.each(['tick', 'send'] as const)(
      'afterTick + %s clears the anchor and the tick, so the next climb waits for its own tick',
      (advanceOn) => {
        const staged = due({ advanceOn, lastTick: { queueItemUuid: 'item-1', status: 'send' } });
        expect(next(fire(staged))).toMatchObject({ anchorMs: null, lastTick: null, lastFiredBeatMs: NOW });
      },
    );

    it('takes the beat from the stored clock and ignores the beat age the phone reports', () => {
      expect(next(fire(due(), 3_600_000))).toEqual(next(fire(due(), 0)));
      expect(next(fire(beat(), 45_000))?.lastFiredBeatMs).toBe(NOW);
    });

    describe('a beat counts as due from REST_CADENCE_FIRE_EARLY_TOLERANCE_MS before it', () => {
      const early = REST_CADENCE_FIRE_EARLY_TOLERANCE_MS;

      it('afterTick: claims a deadline exactly that far ahead, refuses one a millisecond further', () => {
        expect(next(fire(due({ anchorMs: NOW - 90_000 + early })))?.lastFiredBeatMs).toBe(NOW + early);
        expect(fire(due({ anchorMs: NOW - 90_000 + early + 1 }))).toEqual({ applicable: false });
      });

      it('onTheMinute: claims a beat exactly that far ahead, refuses one a millisecond further', () => {
        expect(next(fire(beat({ anchorMs: NOW - 60_000 + early })))?.lastFiredBeatMs).toBe(NOW + early);
        expect(fire(beat({ anchorMs: NOW - 60_000 + early + 1 }))).toEqual({ applicable: false });
      });

      it('onTheMinute never claims the anchor itself, so arming on a boundary waits a full beat', () => {
        expect(claimableRestCadenceBeatMs(beat({ anchorMs: NOW }), NOW)).toBeNull();
        expect(claimableRestCadenceBeatMs(beat({ anchorMs: NOW }), NOW + 60_000 - early)).toBe(NOW + 60_000);
      });
    });

    describe('once per beat', () => {
      it('onTheMinute refuses the beat it already fired, whatever beat age the phone reports', () => {
        const fired = beat({ lastFiredBeatMs: NOW });
        expect(fire(fired, 0, NOW + 100)).toEqual({ applicable: false });
        expect(fire(fired, 90, NOW + 100)).toEqual({ applicable: false });
        expect(fire(fired, 0, NOW + 30_000)).toEqual({ applicable: false });
      });

      it('onTheMinute claims the next beat from the tolerance before it, and not a millisecond sooner', () => {
        const fired = beat({ lastFiredBeatMs: NOW });
        const nextBeat = NOW + 60_000;
        expect(fire(fired, 0, nextBeat - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS - 1)).toEqual({ applicable: false });
        expect(next(fire(fired, 0, nextBeat - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS))?.lastFiredBeatMs).toBe(nextBeat);
      });

      it('afterTick refuses a deadline at or before the last beat it fired, such as a tick dated before that advance', () => {
        expect(fire(due({ anchorMs: NOW - 95_000, lastFiredBeatMs: NOW - 5_000 }))).toEqual({ applicable: false });
        expect(next(fire(due({ anchorMs: NOW - 95_000, lastFiredBeatMs: NOW - 5_001 })))?.lastFiredBeatMs).toBe(
          NOW - 5_000,
        );
      });
    });

    it.each([
      ['paused', due({ isRunning: false })],
      ['auto-advance off', due({ autoAdvance: false })],
      ['the length Off', due({ targetSeconds: null })],
      ['waiting for a tick', due({ anchorMs: null })],
      ['not due yet', clock()],
    ])('cannot fire a clock that is %s', (_label, previous) => {
      expect(fire(previous)).toEqual({ applicable: false });
    });

    it.each([
      ['tick', null],
      ['send', null],
      ['send', { queueItemUuid: 'item-1', status: 'attempt' }],
    ] as const)('cannot fire under %s without the tick it needs (last tick %j)', (advanceOn, lastTick) => {
      expect(fire(due({ advanceOn, lastTick }))).toEqual({ applicable: false });
    });

    it.each([
      ['tick', 'attempt'],
      ['send', 'flash'],
      ['send', 'send'],
    ] as const)('fires under %s after a %s', (advanceOn, status) => {
      expect(fire(due({ advanceOn, lastTick: { queueItemUuid: 'item-1', status } })).applicable).toBe(true);
    });

    it('cannot fire without a revision to compare against', () => {
      expect(reduce(due(), { action: 'FIRE' })).toEqual({ applicable: false });
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

/** An in-memory store, held to the store contract, whose compare-and-set can be made to lose races on demand. */
function memoryStore(initial: StoredRestCadence, racingWriter?: () => StoredRestCadence | null) {
  let stored = { revision: initial.revision, doc: serializeRestCadence(initial.cadence) };
  const writes: string[] = [];
  const store: RestCadenceStore = {
    read: async () => ({ revision: stored.revision, cadence: parseRestCadence(stored.doc) }),
    compareAndSet: async (expectedRevision, nextDoc, minimumRevision) => {
      const raced = racingWriter?.();
      if (raced) stored = { revision: raced.revision, doc: serializeRestCadence(raced.cadence) };
      if (stored.revision !== expectedRevision) return { ok: false, ...stored };
      stored = { revision: Math.max(stored.revision + 1, minimumRevision), doc: nextDoc };
      writes.push(nextDoc);
      return { ok: true, ...stored };
    },
  };
  return { store, writes, current: () => stored };
}

describe('restCadenceRevisionFloor', () => {
  it('counts whole seconds since the start of 2026', () => {
    expect(restCadenceRevisionFloor(REST_CADENCE_REVISION_EPOCH_MS)).toBe(0);
    expect(restCadenceRevisionFloor(REST_CADENCE_REVISION_EPOCH_MS + 2_999)).toBe(2);
    expect(restCadenceRevisionFloor(NOW + 1_000)).toBe(restCadenceRevisionFloor(NOW) + 1);
  });

  it('never goes below zero for a clock set before 2026', () => {
    expect(restCadenceRevisionFloor(REST_CADENCE_REVISION_EPOCH_MS - 60_000)).toBe(0);
  });

  it("fits GraphQL's 32-bit Int until 2094", () => {
    expect(restCadenceRevisionFloor(Date.UTC(2094, 0, 1))).toBeLessThan(2_147_483_647);
  });
});

// Revisions sit above the floor once a session has had a write at NOW.
const FLOOR = restCadenceRevisionFloor(NOW);

describe('commitRestCadenceAction', () => {
  it('writes the next revision when the action applies', async () => {
    const { store, writes } = memoryStore({ revision: FLOOR + 3, cadence: clock() });
    const commit = await commitRestCadenceAction(store, { action: 'TICK', tickStatus: 'send' }, NOW, ME);
    expect(commit.applied).toBe(true);
    expect(commit.rewound).toBe(false);
    expect(commit.stored.revision).toBe(FLOOR + 4);
    expect(commit.stored.cadence?.anchorMs).toBe(NOW);
    expect(writes).toHaveLength(1);
  });

  it('writes no lower than the seconds-since-2026 floor, so a store that lost state still climbs', async () => {
    // Redis came back from an old snapshot at revision 3; the crew holds revisions near FLOOR.
    const { store } = memoryStore({ revision: 3, cadence: clock() });
    const commit = await commitRestCadenceAction(store, { action: 'DISARM' }, NOW + 5_000, ME);
    expect(commit).toEqual({ applied: true, rewound: false, stored: { revision: FLOOR + 5, cadence: null } });
  });

  it('writes nothing for an action that does not apply, or changes nothing', async () => {
    const { store, writes } = memoryStore({ revision: 3, cadence: clock({ isRunning: false }) });
    expect(await commitRestCadenceAction(store, { action: 'PAUSE' }, NOW, ME)).toEqual({
      applied: false,
      rewound: false,
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
    expect(commit).toEqual({ applied: false, rewound: false, stored: { revision: 5, cadence: clock() } });
    expect(writes).toEqual([]);
  });

  it('flags a FIRE from a phone ahead of the store as rewound, without writing', async () => {
    // The holder saw revision 50; the store came back at 3.
    const { store, writes } = memoryStore({ revision: 3, cadence: clock() });
    const commit = await commitRestCadenceAction(store, { action: 'FIRE', expectedRevision: 50 }, NOW, ME);
    expect(commit).toEqual({ applied: false, rewound: true, stored: { revision: 3, cadence: clock() } });
    expect(writes).toEqual([]);
  });

  it('flags a rewind whatever the action, as long as the call is fenced', async () => {
    const { store } = memoryStore({ revision: 0, cadence: null });
    expect((await commitRestCadenceAction(store, { action: 'PAUSE', expectedRevision: 12 }, NOW, ME)).rewound).toBe(
      true,
    );
    expect((await commitRestCadenceAction(store, { action: 'PAUSE' }, NOW, ME)).rewound).toBe(false);
  });

  it('a FIRE that loses the race reports the winner and never retries', async () => {
    const winner = clock({ lastFiredBeatMs: NOW - 10, anchorMs: NOW - 10 });
    let raced = false;
    const { store, writes } = memoryStore({ revision: 5, cadence: clock({ anchorMs: NOW - 90_000 }) }, () => {
      if (raced) return null;
      raced = true;
      return { revision: 6, cadence: winner };
    });
    const commit = await commitRestCadenceAction(store, { action: 'FIRE', expectedRevision: 5 }, NOW, ME);
    expect(commit).toEqual({ applied: false, rewound: false, stored: { revision: 6, cadence: winner } });
    expect(writes).toEqual([]);
  });

  it('an un-fenced call re-reads and retries a lost race on the winning state', async () => {
    let races = 0;
    const { store } = memoryStore({ revision: FLOOR + 1, cadence: clock() }, () => {
      if (races >= 2) return null;
      races += 1;
      return { revision: FLOOR + 1 + races, cadence: clock({ isRunning: races % 2 === 0 }) };
    });
    const commit = await commitRestCadenceAction(
      store,
      { action: 'TICK', tickQueueItemUuid: 'item-9', tickStatus: 'flash' },
      NOW,
      ME,
    );
    expect(commit.applied).toBe(true);
    expect(commit.stored.revision).toBe(FLOOR + 4);
    expect(commit.stored.cadence?.lastTick).toEqual({ queueItemUuid: 'item-9', status: 'flash' });
  });

  describe('a FIRE claims each beat once (#6724 review)', () => {
    it('refuses a second FIRE on the same onTheMinute beat, even on the revision the first one returned', async () => {
      // Armed a minute ago on a 60 s beat: the first beat falls due at NOW.
      const { store, writes } = memoryStore({
        revision: FLOOR,
        cadence: clock({ ...ON_THE_MINUTE, anchorMs: NOW - 60_000 }),
      });
      const first = await commitRestCadenceAction(
        store,
        { action: 'FIRE', expectedRevision: FLOOR, firedBeatAgoMs: 0 },
        NOW,
        ME,
      );
      const second = await commitRestCadenceAction(
        store,
        { action: 'FIRE', expectedRevision: first.stored.revision, firedBeatAgoMs: 90 },
        NOW + 100,
        PEER,
      );
      expect(first.applied).toBe(true);
      expect(second).toEqual({ applied: false, rewound: false, stored: first.stored });
      expect(writes).toHaveLength(1);
    });

    it('refuses a second afterTick + deadline FIRE on the revision the first one returned', async () => {
      // A 90 s rest that started 90 s ago: due at NOW.
      const { store, writes } = memoryStore({ revision: FLOOR, cadence: clock({ anchorMs: NOW - 90_000 }) });
      const first = await commitRestCadenceAction(
        store,
        { action: 'FIRE', expectedRevision: FLOOR, firedBeatAgoMs: 0 },
        NOW,
        ME,
      );
      const second = await commitRestCadenceAction(
        store,
        { action: 'FIRE', expectedRevision: first.stored.revision, firedBeatAgoMs: 0 },
        NOW + 100,
        PEER,
      );
      expect(first.applied).toBe(true);
      expect(second).toEqual({ applied: false, rewound: false, stored: first.stored });
      expect(writes).toHaveLength(1);
    });

    /** FIRE on whatever revision the store holds now, as a phone that adopted every event would. */
    const fireOnLatest = async (store: RestCadenceStore, nowMs: number, firedBeatAgoMs = 0) =>
      commitRestCadenceAction(
        store,
        { action: 'FIRE', expectedRevision: (await store.read()).revision, firedBeatAgoMs },
        nowMs,
        PEER,
      );

    it('onTheMinute: the next beat applies from the tolerance before it, on the revision the last FIRE wrote', async () => {
      const { store, writes } = memoryStore({
        revision: FLOOR,
        cadence: clock({ ...ON_THE_MINUTE, anchorMs: NOW - 60_000 }),
      });
      expect((await fireOnLatest(store, NOW)).applied).toBe(true);

      const nextBeat = NOW + 60_000;
      const tooEarly = await fireOnLatest(store, nextBeat - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS - 1);
      const onTime = await fireOnLatest(store, nextBeat - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS);

      expect(tooEarly.applied).toBe(false);
      expect(onTime.applied).toBe(true);
      expect(onTime.stored.cadence?.lastFiredBeatMs).toBe(nextBeat);
      expect(writes).toHaveLength(2);
    });

    it('afterTick + deadline: the next cycle applies once its own rest has run', async () => {
      const { store } = memoryStore({ revision: FLOOR, cadence: clock({ anchorMs: NOW - 90_000 }) });
      expect((await fireOnLatest(store, NOW)).applied).toBe(true);

      // The first FIRE restarted the rest at NOW, so the next deadline is NOW + 90 s.
      expect((await fireOnLatest(store, NOW + 30_000)).applied).toBe(false);
      const nextCycle = await fireOnLatest(store, NOW + 90_000);
      expect(nextCycle.applied).toBe(true);
      expect(nextCycle.stored.cadence).toMatchObject({ lastFiredBeatMs: NOW + 90_000, anchorMs: NOW + 90_000 });
    });

    it.each(['tick', 'send'] as const)(
      'afterTick + %s: a second FIRE is refused, and the next one waits for a tick and its full rest',
      async (advanceOn) => {
        const { store } = memoryStore({
          revision: FLOOR,
          cadence: clock({ advanceOn, anchorMs: NOW - 90_000, lastTick: { queueItemUuid: 'item-1', status: 'send' } }),
        });
        expect((await fireOnLatest(store, NOW)).applied).toBe(true);
        expect((await fireOnLatest(store, NOW + 100)).applied).toBe(false);

        // A send on the next climb, ten seconds later, starts its rest.
        await commitRestCadenceAction(
          store,
          { action: 'TICK', tickQueueItemUuid: 'item-2', tickStatus: 'send' },
          NOW + 10_000,
          ME,
        );
        expect((await fireOnLatest(store, NOW + 10_100)).applied).toBe(false);
        expect((await fireOnLatest(store, NOW + 100_000)).applied).toBe(true);
      },
    );
  });

  it('gives up after a bounded number of lost races', async () => {
    let revision = 1;
    const { store, writes } = memoryStore({ revision, cadence: clock() }, () => {
      revision += 1;
      return { revision, cadence: clock() };
    });
    const commit = await commitRestCadenceAction(store, { action: 'RESET' }, NOW, ME);
    expect(commit.applied).toBe(false);
    expect(commit.rewound).toBe(false);
    expect(commit.stored.revision).toBe(1 + REST_CADENCE_CAS_ATTEMPTS);
    expect(writes).toEqual([]);
  });
});
