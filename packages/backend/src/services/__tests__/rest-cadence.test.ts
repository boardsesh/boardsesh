import { describe, expect, it } from 'vite-plus/test';
import {
  REST_CADENCE_CAS_ATTEMPTS,
  REST_CADENCE_FIRE_EARLY_TOLERANCE_MS,
  REST_CADENCE_FIRE_LATE_TOLERANCE_MS,
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
      const longRest = clock({ anchorMs: NOW - 10 * 60_000 });
      expect(next(reduce(longRest, { action: 'TICK', tickStatus: 'send', elapsedMs: 3_600_000 }))?.anchorMs).toBe(
        NOW - 60_000,
      );
    });

    it('the first tick of a session anchors where the climber logged it', () => {
      const waiting = clock({ anchorMs: null, lastFiredBeatMs: null });
      expect(next(reduce(waiting, { action: 'TICK', tickStatus: 'send', elapsedMs: 4_000 }))?.anchorMs).toBe(
        NOW - 4_000,
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

    describe('a backdated tick never starts a rest before the running one or the last advance (#6724 review)', () => {
      const SIXTY: RestCadenceConfig = { ...AFTER_TICK, targetSeconds: 60 };
      const fireAt = (state: RestCadenceState, nowMs: number) =>
        applyRestCadenceAction(state, { action: 'FIRE', expectedRevision: 1 }, nowMs, ME);
      const at = (state: RestCadenceState, input: RestCadenceInput, nowMs: number) =>
        next(applyRestCadenceAction(state, input, nowMs, ME))!;
      // A 60 s rest whose deadline B is NOW.
      const B = NOW;
      const dueAtB = clock({ ...SIXTY, anchorMs: B - 60_000 });

      it('a tick dated 55 s back, 2 s after an advance, waits a full rest from the advance', () => {
        const advanced = next(fireAt(dueAtB, B))!;
        const lateTick = at(advanced, { action: 'TICK', tickStatus: 'send', elapsedMs: 55_000 }, B + 2_000);
        // Without the floor this anchored at B - 53 s, so the next advance fired at B + 7 s.
        expect(lateTick.anchorMs).toBe(B);
        for (const nowMs of [B + 5_000, B + 7_000, B + 60_000 - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS - 1]) {
          expect(fireAt(lateTick, nowMs)).toEqual({ applicable: false });
        }
        expect(next(fireAt(lateTick, B + 60_000))?.lastFiredBeatMs).toBe(B + 60_000);
      });

      it("a crewmate's late tick on the previous climb keeps the rest the new climb's tick started", () => {
        const advanced = next(fireAt(dueAtB, B))!;
        const newClimb = at(advanced, { action: 'TICK', tickQueueItemUuid: 'item-2', tickStatus: 'send' }, B + 20_000);
        expect(newClimb.anchorMs).toBe(B + 20_000);
        // Logged at B - 5 s, it reaches the server at B + 30 s.
        const previousClimb = at(
          newClimb,
          { action: 'TICK', tickQueueItemUuid: 'item-1', tickStatus: 'send', elapsedMs: 35_000 },
          B + 30_000,
        );
        expect(previousClimb.anchorMs).toBe(B + 20_000);
        expect(claimableRestCadenceBeatMs(previousClimb, B + 80_000)).toBe(B + 80_000);
        expect(
          claimableRestCadenceBeatMs(previousClimb, B + 80_000 - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS - 1),
        ).toBeNull();
      });

      it('a fresh tick still restarts the rest from the tick', () => {
        const ticked = at(dueAtB, { action: 'TICK', tickStatus: 'send', elapsedMs: 1_000 }, B - 30_000);
        expect(ticked.anchorMs).toBe(B - 31_000);
      });

      it('never anchors in the future after an early FIRE stored a beat ahead of now', () => {
        // The holder fired 2 s early: the advance anchored on B, 2 s ahead of the server clock.
        const advanced = next(fireAt(dueAtB, B - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS))!;
        expect(advanced).toMatchObject({ anchorMs: B, lastFiredBeatMs: B });
        for (const elapsedMs of [0, 55_000]) {
          const ticked = at(advanced, { action: 'TICK', tickStatus: 'send', elapsedMs }, B - 1_500);
          expect(ticked.anchorMs).toBe(B - 1_500);
        }
      });

      it('never anchors in the future after RESUME shifted the fired beat past now', () => {
        // onTheMinute: an early FIRE on B, a PAUSE straight after (58 whole seconds frozen), RESUME 100 s later.
        const fired = next(fireAt(clock({ ...ON_THE_MINUTE, anchorMs: B - 60_000 }), B - 2_000))!;
        const paused = at(fired, { action: 'PAUSE' }, B - 1_900);
        const resumed = at(paused, { action: 'RESUME' }, B + 100_000);
        expect(resumed).toMatchObject({ anchorMs: B + 42_000, lastFiredBeatMs: B + 102_000 });
        // A stage boundary that waits for a tick, then the tick: it fills the anchor with the floored value.
        const waiting = at(resumed, { action: 'CONFIGURE', config: ON_THE_MINUTE, anchor: 'CLEAR' }, B + 100_100);
        const ticked = at(waiting, { action: 'TICK', tickStatus: 'send', elapsedMs: 20_000 }, B + 100_500);
        expect(ticked.anchorMs).toBe(B + 100_500);
        // Its first beat is a full interval later, after the fired one.
        expect(next(fireAt(ticked, B + 160_500))?.lastFiredBeatMs).toBe(B + 160_500);
      });

      it('onTheMinute fills an empty anchor no earlier than the last advance', () => {
        const waiting = clock({ ...ON_THE_MINUTE, anchorMs: null, lastFiredBeatMs: B });
        expect(at(waiting, { action: 'TICK', tickStatus: 'send', elapsedMs: 55_000 }, B + 2_000).anchorMs).toBe(B);
        // A beat it already holds is never moved.
        const holding = clock({ ...ON_THE_MINUTE, anchorMs: B - 60_000, lastFiredBeatMs: B });
        expect(at(holding, { action: 'TICK', tickStatus: 'send' }, B + 2_000).anchorMs).toBe(B - 60_000);
      });

      it.each(['tick', 'send'] as const)(
        'afterTick + %s: a late tick on the previous climb after an advance starts a full rest from the advance',
        (advanceOn) => {
          const staged = clock({
            ...SIXTY,
            advanceOn,
            anchorMs: B - 60_000,
            lastTick: { queueItemUuid: 'item-1', status: 'send' },
          });
          const advanced = next(fireAt(staged, B))!;
          expect(advanced).toMatchObject({ anchorMs: null, lastTick: null, lastFiredBeatMs: B });
          const lateTick = at(
            advanced,
            { action: 'TICK', tickQueueItemUuid: 'item-1', tickStatus: 'send', elapsedMs: 55_000 },
            B + 2_000,
          );
          expect(lateTick.anchorMs).toBe(B);
          expect(fireAt(lateTick, B + 7_000)).toEqual({ applicable: false });
          expect(fireAt(lateTick, B + 60_000 - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS - 1)).toEqual({
            applicable: false,
          });
          expect(next(fireAt(lateTick, B + 60_000))?.lastFiredBeatMs).toBe(B + 60_000);
        },
      );
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
      // Beats at NOW - 123 s, - 63 s and - 3 s.
      expect(next(fire(beat({ anchorMs: NOW - 183_000 })))?.lastFiredBeatMs).toBe(NOW - 3_000);
    });

    it('afterTick + deadline: a FIRE inside the early tolerance restarts the rest from the deadline, not from the FIRE', () => {
      // The deadline is NOW + 1.5 s; the holder's clock runs 1.5 s fast.
      const early = next(fire(due({ anchorMs: NOW - 90_000 + 1_500 })));
      expect(early).toMatchObject({ lastFiredBeatMs: NOW + 1_500, anchorMs: NOW + 1_500 });
      // So the next deadline is a full rest after the one claimed.
      expect(claimableRestCadenceBeatMs(early!, NOW + 91_500)).toBe(NOW + 91_500);
      expect(claimableRestCadenceBeatMs(early!, NOW + 91_500 - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS - 1)).toBeNull();
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

    describe('a beat is claimable until REST_CADENCE_FIRE_LATE_TOLERANCE_MS after it (#6724 review)', () => {
      const late = REST_CADENCE_FIRE_LATE_TOLERANCE_MS;

      it('afterTick: claims a deadline exactly that far gone, refuses one a millisecond further', () => {
        expect(next(fire(due({ anchorMs: NOW - 90_000 - late })))?.lastFiredBeatMs).toBe(NOW - late);
        expect(fire(due({ anchorMs: NOW - 90_000 - late - 1 }))).toEqual({ applicable: false });
      });

      it('onTheMinute: claims a beat exactly that far gone, refuses one a millisecond further', () => {
        expect(next(fire(beat({ anchorMs: NOW - 60_000 - late })))?.lastFiredBeatMs).toBe(NOW - late);
        expect(fire(beat({ anchorMs: NOW - 60_000 - late - 1 }))).toEqual({ applicable: false });
      });

      it('onTheMinute: a missed beat is never claimed late enough to sit next to the next one', () => {
        // Beat 1 (NOW + 60 s) never fired. A FIRE 57.5 s after it used to claim it, and one a second later claimed beat 2.
        const missed = beat({ anchorMs: NOW });
        expect(fire(missed, 0, NOW + 117_500)).toEqual({ applicable: false });
        const onBeatTwo = next(fire(missed, 0, NOW + 118_500));
        expect(onBeatTwo?.lastFiredBeatMs).toBe(NOW + 120_000);
        expect(fire(onBeatTwo!, 0, NOW + 118_600)).toEqual({ applicable: false });
      });

      it('two FIREs that both apply are at least 8 s apart on the shortest (15 s) grid', () => {
        const fifteen = beat({ targetSeconds: 15, anchorMs: NOW });
        // As late as beat 1 (NOW + 15 s) can be claimed.
        const first = next(fire(fifteen, 0, NOW + 15_000 + late));
        expect(first?.lastFiredBeatMs).toBe(NOW + 15_000);
        // Beat 2 (NOW + 30 s) opens at NOW + 28 s: 8 s later, and not a millisecond sooner.
        expect(fire(first!, 0, NOW + 28_000 - 1)).toEqual({ applicable: false });
        expect(next(fire(first!, 0, NOW + 28_000))?.lastFiredBeatMs).toBe(NOW + 30_000);
      });

      it('afterTick + deadline: a stale deadline stays refused until a TICK, a RESET or a CONFIGURE NOW re-anchors it', () => {
        // The holder slept through a 90 s rest that ran out 18.5 minutes ago.
        const stale = due({ anchorMs: NOW - 20 * 60_000 });
        expect(fire(stale)).toEqual({ applicable: false });
        expect(fire(stale, 0, NOW + 60 * 60_000)).toEqual({ applicable: false });

        const reanchored = [
          next(reduce(stale, { action: 'RESET' })),
          next(reduce(stale, { action: 'CONFIGURE', config: AFTER_TICK, anchor: 'NOW', elapsedMs: 0 })),
          next(reduce(stale, { action: 'TICK', tickStatus: 'send' })),
        ];
        for (const state of reanchored) {
          expect(fire(state!, 0, NOW + 30_000)).toEqual({ applicable: false });
          expect(next(fire(state!, 0, NOW + 90_000))?.lastFiredBeatMs).toBe(NOW + 90_000);
        }
      });

      it('onTheMinute recovers on its next beat after missing one', () => {
        // The last beat fell due 10 s ago and nobody fired it.
        const missed = beat({ anchorMs: NOW - 70_000 });
        expect(fire(missed)).toEqual({ applicable: false });
        expect(next(fire(missed, 0, NOW + 50_000 - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS))?.lastFiredBeatMs).toBe(
          NOW + 50_000,
        );
      });

      it('an ARM whose elapsed is past a beat cannot fire it on the spot', () => {
        // Armed an hour and 30 s in: the last beat on the 60 s grid fell due 30 s ago.
        const armedLate = next(reduce(null, { action: 'ARM', config: ON_THE_MINUTE, elapsedMs: 3_630_000 }));
        expect(fire(armedLate!)).toEqual({ applicable: false });
        expect(next(fire(armedLate!, 0, NOW + 30_000))?.lastFiredBeatMs).toBe(NOW + 30_000);
        // An afterTick rest that ran out long ago stays out.
        const restLate = next(reduce(null, { action: 'ARM', config: AFTER_TICK, elapsedMs: 3_600_000 }));
        expect(fire(restLate!)).toEqual({ applicable: false });
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

      it('afterTick refuses a deadline at or before the last beat it fired, such as a CONFIGURE NOW dated before that advance', () => {
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

    describe('the fired beat across a pause and a reset (#6724 review)', () => {
      const fireAt = (state: RestCadenceState, nowMs: number) =>
        applyRestCadenceAction(state, { action: 'FIRE', expectedRevision: 1 }, nowMs, ME);
      const at = (state: RestCadenceState, input: RestCadenceInput, nowMs: number) =>
        next(applyRestCadenceAction(state, input, nowMs, ME))!;
      // A 60 s beat armed a minute ago: its first beat is NOW.
      const beat = (overrides: Partial<RestCadenceState> = {}) =>
        clock({ ...ON_THE_MINUTE, anchorMs: NOW - 60_000, ...overrides });

      it('RESUME moves the fired beat with the grid, so the beat fired before a pause is not claimed again', () => {
        const fired = next(fireAt(beat(), NOW))!;
        const paused = at(fired, { action: 'PAUSE' }, NOW + 500);
        expect(paused.pausedElapsedSeconds).toBe(60);
        const resumed = at(paused, { action: 'RESUME' }, NOW + 30_000);
        // The grid moved 30 s later, and the fired beat with it.
        expect(resumed).toMatchObject({ anchorMs: NOW - 30_000, lastFiredBeatMs: NOW + 30_000 });

        // The beat the clock shows right after RESUME is the one already fired.
        expect(fireAt(resumed, NOW + 30_000)).toEqual({ applicable: false });
        expect(fireAt(resumed, NOW + 35_000)).toEqual({ applicable: false });
        // The next beat on the new grid applies.
        expect(fireAt(resumed, NOW + 90_000 - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS - 1)).toEqual({
          applicable: false,
        });
        expect(next(fireAt(resumed, NOW + 90_000 - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS))?.lastFiredBeatMs).toBe(
          NOW + 90_000,
        );
      });

      it('RESUME leaves the fired beat alone when nothing fired or the clock was waiting for a tick', () => {
        const neverFired = at(beat({ isRunning: false, pausedElapsedSeconds: 20 }), { action: 'RESUME' }, NOW);
        expect(neverFired.lastFiredBeatMs).toBeNull();
        const waiting = clock({ advanceOn: 'send', anchorMs: null, lastFiredBeatMs: NOW - 5_000, isRunning: false });
        expect(at(waiting, { action: 'RESUME' }, NOW).lastFiredBeatMs).toBe(NOW - 5_000);
      });

      it.each([
        ['afterTick on a 90 s rest', clock({ targetSeconds: 90 })],
        ['onTheMinute on a 70 s grid', clock({ ...ON_THE_MINUTE, targetSeconds: 70 })],
      ])('RESUME after the longest pause (4 h frozen) cannot fire on the spot: %s', (_label, running) => {
        const paused = { ...running, isRunning: false, pausedElapsedSeconds: 14_400 };
        const resumed = at(paused, { action: 'RESUME' }, NOW);
        expect(resumed.anchorMs).toBe(NOW - 14_400_000);
        expect(fireAt(resumed, NOW)).toEqual({ applicable: false });
        expect(fireAt(resumed, NOW + 3_000)).toEqual({ applicable: false });
      });

      it('RESUME after a 4 h freeze on a 70 s grid fires on the next beat, not the one 50 s gone', () => {
        // 14 400 s = 205 beats of 70 s plus 50 s, so the next beat is 20 s after RESUME.
        const resumed = at(
          clock({ ...ON_THE_MINUTE, targetSeconds: 70, isRunning: false, pausedElapsedSeconds: 14_400 }),
          { action: 'RESUME' },
          NOW,
        );
        expect(next(fireAt(resumed, NOW + 20_000))?.lastFiredBeatMs).toBe(NOW + 20_000);
      });

      it('RESET clears the last tick and keeps the fired beat, as the phone does', () => {
        const previous = clock({ lastFiredBeatMs: NOW - 1_000, lastTick: { queueItemUuid: 'item-1', status: 'send' } });
        expect(next(reduce(previous, { action: 'RESET' }))).toMatchObject({
          anchorMs: NOW,
          lastFiredBeatMs: NOW - 1_000,
          lastTick: null,
        });
        expect(next(reduce(previous, { action: 'RESET', isRunning: false }))).toMatchObject({
          anchorMs: null,
          lastFiredBeatMs: NOW - 1_000,
          lastTick: null,
        });
      });

      it.each([
        ['onTheMinute', beat()],
        ['afterTick + deadline', clock({ anchorMs: NOW - 90_000 })],
      ])('%s: no beat fired before a RESET can be claimed after it', (_label, dueNow) => {
        // The holder fired as early as it may, and someone reset straight after.
        const fired = next(fireAt(dueNow, NOW - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS))!;
        expect(fired.lastFiredBeatMs).toBe(NOW);
        const reset = at(fired, { action: 'RESET' }, NOW - 1_500);
        expect(reset.lastFiredBeatMs).toBe(NOW);

        for (const nowMs of [NOW - 1_500, NOW, NOW + 3_000, NOW + 20_000]) {
          expect(fireAt(reset, nowMs)).toEqual({ applicable: false });
        }
        // The first beat after the RESET is a full interval after it.
        const intervalMs = (dueNow.targetSeconds ?? 0) * 1000;
        expect(next(fireAt(reset, NOW - 1_500 + intervalMs))?.lastFiredBeatMs).toBe(NOW - 1_500 + intervalMs);
      });

      it('a backdated TICK after a RESET cannot re-anchor onto the beat an early FIRE claimed before it', () => {
        // An early FIRE claims B = NOW at NOW - 2 s, a RESET lands at NOW - 1.5 s, and a tick
        // dated 59 s back lands at NOW - 1 s. Clearing the fired beat on RESET let this anchor at
        // NOW - 60 s and the FIRE at NOW apply a second time.
        const due = clock({ ...AFTER_TICK, targetSeconds: 60, anchorMs: NOW - 60_000 });
        const fired = next(fireAt(due, NOW - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS))!;
        const reset = at(fired, { action: 'RESET' }, NOW - 1_500);
        const ticked = at(reset, { action: 'TICK', tickStatus: 'send', elapsedMs: 59_000 }, NOW - 1_000);
        expect(ticked).toMatchObject({ lastFiredBeatMs: NOW, anchorMs: NOW - 1_000 });
        expect(fireAt(ticked, NOW)).toEqual({ applicable: false });
        expect(fireAt(ticked, NOW + 3_000)).toEqual({ applicable: false });
        expect(next(fireAt(ticked, NOW + 59_000))?.lastFiredBeatMs).toBe(NOW + 59_000);
      });

      it.each(['tick', 'send'] as const)(
        'afterTick + %s: a tick from before a RESET no longer lets the wall advance',
        (advanceOn) => {
          const ticked = clock({ advanceOn, anchorMs: NOW, lastTick: { queueItemUuid: 'item-1', status: 'send' } });
          const reset = at(ticked, { action: 'RESET' }, NOW + 10_000);
          expect(fireAt(reset, NOW + 100_000)).toEqual({ applicable: false });

          // A tick on the next climb starts a rest that may advance.
          const retick = at(reset, { action: 'TICK', tickQueueItemUuid: 'item-2', tickStatus: 'send' }, NOW + 20_000);
          expect(fireAt(retick, NOW + 100_000)).toEqual({ applicable: false });
          expect(fireAt(retick, NOW + 110_000).applicable).toBe(true);
        },
      );
    });
  });

  describe('CONFIGURE onto a new interval, against the beat already fired (#6724 review)', () => {
    const fireAt = (state: RestCadenceState, nowMs: number) =>
      applyRestCadenceAction(state, { action: 'FIRE', expectedRevision: 1 }, nowMs, ME);
    const configure = (state: RestCadenceState, targetSeconds: number, nowMs: number) =>
      next(
        applyRestCadenceAction(state, { action: 'CONFIGURE', config: { ...ON_THE_MINUTE, targetSeconds } }, nowMs, ME),
      )!;

    it('60 s → 15 s: the shared instant is not claimed twice, and the first new beat after it applies', () => {
      // Anchored at NOW - 60 s; the 60 s beat at NOW fired.
      const fired = next(fireAt(clock({ ...ON_THE_MINUTE, anchorMs: NOW - 60_000 }), NOW))!;
      const fifteen = configure(fired, 15, NOW + 1_000);
      expect(fifteen.lastFiredBeatMs).toBe(NOW);
      // NOW is on the 15 s grid too, and it already fired.
      expect(fireAt(fifteen, NOW + 1_000)).toEqual({ applicable: false });
      expect(next(fireAt(fifteen, NOW + 15_000 - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS))?.lastFiredBeatMs).toBe(
        NOW + 15_000,
      );
    });

    it('15 s → 60 s: the first beat of the new grid applies', () => {
      // Anchored at NOW - 45 s; the 15 s beat at NOW fired. The 60 s grid's first beat is NOW + 15 s.
      const fired = next(fireAt(clock({ ...ON_THE_MINUTE, targetSeconds: 15, anchorMs: NOW - 45_000 }), NOW))!;
      const sixty = configure(fired, 60, NOW + 1_000);
      expect(fireAt(sixty, NOW + 1_000)).toEqual({ applicable: false });
      expect(fireAt(sixty, NOW + 15_000 - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS - 1)).toEqual({ applicable: false });
      expect(next(fireAt(sixty, NOW + 15_000 - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS))?.lastFiredBeatMs).toBe(
        NOW + 15_000,
      );
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

    it('lets one FIRE per beat apply when every phone reads the revision and commits at the same time', async () => {
      const { store, writes } = memoryStore({
        revision: FLOOR,
        cadence: clock({ ...ON_THE_MINUTE, anchorMs: NOW - 60_000 }),
      });
      /** Twelve phones that each read the latest revision, then FIRE on it, all at once. */
      const burst = (nowMs: number) =>
        Promise.all(Array.from({ length: 12 }, (_, index) => fireOnLatest(store, nowMs + index * 50, index * 7)));

      expect((await burst(NOW)).filter((commit) => commit.applied)).toHaveLength(1);
      expect((await store.read()).cadence?.lastFiredBeatMs).toBe(NOW);

      const onNextBeat = await burst(NOW + 60_000 - REST_CADENCE_FIRE_EARLY_TOLERANCE_MS);
      expect(onNextBeat.filter((commit) => commit.applied)).toHaveLength(1);
      expect((await store.read()).cadence?.lastFiredBeatMs).toBe(NOW + 60_000);
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
