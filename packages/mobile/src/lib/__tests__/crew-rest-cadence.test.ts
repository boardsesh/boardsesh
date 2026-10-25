import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRestCadenceChangeWire, SessionRestCadenceWire } from '../graphql/operations';
import {
  CREW_FIRE_EARLY_TOLERANCE_MS,
  CREW_FIRE_LATE_TOLERANCE_MS,
  MAX_CREW_FIRE_RETRIES,
  buildArmInput,
  buildConfigureInput,
  buildCrewPacingEditInput,
  buildRestartInput,
  buildTickInput,
  crewBeatFenced,
  editCrewRestPacing,
  crewBeatServerMs,
  getLastCrewCadenceSnapshot,
  handleCrewCadenceChange,
  noteCrewClockArmedHere,
  noteCrewClockTurnedOffHere,
  parseCrewRestCadence,
  planCrewFireOutcome,
  rebaseCrewPacingDraft,
  resetCrewCadenceForTests,
  sameCrewConfig,
  spendAdvanceOnce,
  subscribeCrewCadenceSnapshots,
  toCrewConfigInput,
  type OwnRestPacing,
} from '../crew-rest-cadence';
import { armRestTimer, getRestTimerState, resetRestTimerStoreForTests } from '../rest-timer-store';
import { noteServerTimeFromMutation, resetServerClock } from '../server-clock';

const SESSION = 'session-1';
const ME = 'participant-me';
const SAM = 'participant-sam';
const T0 = 1_800_000_000_000;

function wireClock(overrides: Partial<SessionRestCadenceWire> = {}): SessionRestCadenceWire {
  return {
    mode: 'afterTick',
    targetSeconds: 60,
    autoAdvance: true,
    advanceOn: 'deadline',
    source: 'settings',
    isRunning: true,
    anchorAt: String(T0),
    pausedElapsedSeconds: 0,
    lastFiredBeatAt: null,
    lastTickQueueItemUuid: null,
    lastTickStatus: null,
    setByParticipantId: SAM,
    ...overrides,
  };
}

function change(overrides: Partial<SessionRestCadenceChangeWire> = {}): SessionRestCadenceChangeWire {
  return {
    restCadence: wireClock(),
    revision: 10,
    serverNow: String(T0 + 1_000),
    isSnapshot: false,
    action: 'ARM',
    ...overrides,
  };
}

const context = { sessionId: SESSION, ownParticipantId: ME, receivedAtMs: T0 + 1_000 };

const ownSettings: OwnRestPacing = {
  mode: 'afterTick',
  targetSeconds: 90,
  autoAdvance: true,
  advanceOn: 'deadline',
  source: 'settings',
};

beforeEach(() => {
  resetRestTimerStoreForTests();
  resetCrewCadenceForTests();
  resetServerClock();
});

describe('parseCrewRestCadence', () => {
  it('turns every server instant into this phone’s clock', () => {
    // The server runs 2 s ahead.
    noteServerTimeFromMutation({ serverNowMs: T0 + 2_100, sentAtMs: T0, receivedAtMs: T0 + 200 });
    const crew = parseCrewRestCadence(
      SESSION,
      4,
      wireClock({ lastFiredBeatAt: String(T0 - 60_000), lastTickQueueItemUuid: 'item-1', lastTickStatus: 'send' }),
    );
    expect(crew.anchorMs).toBe(T0 - 2_000);
    expect(crew.anchorServerMs).toBe(T0);
    expect(crew.lastFiredBeatMs).toBe(T0 - 62_000);
    expect(crew.lastTick).toEqual({ status: 'send', queueItemUuid: 'item-1' });
    expect(crew.config).toEqual({
      mode: 'afterTick',
      targetSeconds: 60,
      autoAdvance: true,
      advanceOn: 'deadline',
      source: 'settings',
      setByParticipantId: SAM,
    });
  });

  it.each([{ mode: 'everyOtherMinute' }, { advanceOn: 'beat' }, { source: 'partner' }])(
    'holds a clock with %j as unsupported, never as something it is not',
    (overrides) => {
      expect(parseCrewRestCadence(SESSION, 1, wireClock(overrides)).config).toBeNull();
    },
  );

  it('reads a waiting clock and an unknown tick status as nothing', () => {
    const crew = parseCrewRestCadence(SESSION, 1, wireClock({ anchorAt: null, lastTickStatus: 'topped' }));
    expect(crew.anchorMs).toBeNull();
    expect(crew.lastTick).toBeNull();
  });
});

describe('handleCrewCadenceChange: the revision floor', () => {
  it('drops a change at or below the revision already held', () => {
    expect(handleCrewCadenceChange(change({ revision: 10 }), context)).toBe('adopted');
    expect(handleCrewCadenceChange(change({ revision: 10, action: 'TICK' }), context)).toBe('stale');
    expect(handleCrewCadenceChange(change({ revision: 9 }), context)).toBe('stale');
    expect(handleCrewCadenceChange(change({ revision: 11, action: 'TICK' }), context)).toBe('adopted');
  });

  it('lets a snapshot replace everything and reset the floor', () => {
    handleCrewCadenceChange(change({ revision: 50 }), context);
    expect(
      handleCrewCadenceChange(
        change({ revision: 3, isSnapshot: true, action: null, restCadence: wireClock({ targetSeconds: 120 }) }),
        context,
      ),
    ).toBe('adopted');
    expect(getRestTimerState().crew?.config?.targetSeconds).toBe(120);
    expect(handleCrewCadenceChange(change({ revision: 4 }), context)).toBe('adopted');
  });

  it('keeps one floor per session', () => {
    handleCrewCadenceChange(change({ revision: 50 }), context);
    expect(handleCrewCadenceChange(change({ revision: 2 }), { ...context, sessionId: 'session-2' })).toBe('adopted');
  });

  it('still converts the held clock again from a change too old to take, once its sample moves the offset', () => {
    handleCrewCadenceChange(change({ revision: 10, serverNow: String(T0 + 1_000) }), context);
    expect(getRestTimerState().anchorMs).toBe(T0);
    // A FIRE's reply at the same revision, sent at +0.8 s and back at +1 s: the
    // server reads 4.1 s ahead of this phone.
    expect(
      handleCrewCadenceChange(change({ revision: 10, serverNow: String(T0 + 5_000), action: null }), {
        ...context,
        sentAtMs: T0 + 800,
      }),
    ).toBe('stale');
    expect(getRestTimerState().anchorMs).toBe(T0 - 4_100);
  });

  it('leaves the held clock alone for a sample that barely moves the offset', () => {
    handleCrewCadenceChange(change({ revision: 10, serverNow: String(T0 + 1_000) }), context);
    const before = getRestTimerState();
    handleCrewCadenceChange(change({ revision: 10, serverNow: String(T0 + 1_100), action: null }), {
      ...context,
      receivedAtMs: T0 + 1_010,
      sentAtMs: T0 + 990,
    });
    expect(getRestTimerState()).toBe(before);
  });
});

describe('handleCrewCadenceChange: who may take an armed clock', () => {
  it('takes a clock another member set, arming this phone for the session', () => {
    expect(handleCrewCadenceChange(change(), context)).toBe('adopted');
    const state = getRestTimerState();
    expect(state.armed).toBe(true);
    expect(state.armedForSessionId).toBe(SESSION);
    expect(state.anchorMs).toBe(T0);
  });

  it('never re-arms from an echo of a clock this phone set while it is not armed', () => {
    expect(handleCrewCadenceChange(change({ restCadence: wireClock({ setByParticipantId: ME }) }), context)).toBe(
      'ignored',
    );
    expect(getRestTimerState().armed).toBe(false);
  });

  it('brings back a live clock this phone set from the seed, so the setter keeps pacing (a cold start)', () => {
    const seed = change({ restCadence: wireClock({ setByParticipantId: ME }), isSnapshot: true, action: null });
    expect(handleCrewCadenceChange(seed, context)).toBe('adopted');
    const state = getRestTimerState();
    expect(state.armed).toBe(true);
    expect(state.armedForSessionId).toBe(SESSION);
    expect(state.anchorMs).toBe(T0);
    expect(state.crew?.config?.setByParticipantId).toBe(ME);
  });

  it('does not bring back its own clock from the seed once the climber turned the timer off here', () => {
    noteCrewClockTurnedOffHere(SESSION);
    const seed = change({ restCadence: wireClock({ setByParticipantId: ME }), isSnapshot: true, action: null });
    expect(handleCrewCadenceChange(seed, context)).toBe('ignored');
    expect(getRestTimerState().armed).toBe(false);
  });

  it('brings its own clock back again once the climber turned the timer on again here', () => {
    noteCrewClockTurnedOffHere(SESSION);
    noteCrewClockArmedHere(SESSION);
    const seed = change({ restCadence: wireClock({ setByParticipantId: ME }), isSnapshot: true, action: null });
    expect(handleCrewCadenceChange(seed, context)).toBe('adopted');
  });

  it('cannot restore its own clock from the seed without knowing its own id', () => {
    const seed = change({ restCadence: wireClock({ setByParticipantId: ME }), isSnapshot: true, action: null });
    expect(handleCrewCadenceChange(seed, { ...context, ownParticipantId: null })).toBe('ignored');
    expect(getRestTimerState().armed).toBe(false);
  });

  it('takes its own clock while armed for that session', () => {
    armRestTimer('afterTick', T0, SESSION);
    expect(handleCrewCadenceChange(change({ restCadence: wireClock({ setByParticipantId: ME }) }), context)).toBe(
      'adopted',
    );
    expect(getRestTimerState().crew?.revision).toBe(10);
  });

  it('does not take a clock armed for another session', () => {
    armRestTimer('afterTick', T0, 'session-other');
    expect(handleCrewCadenceChange(change({ restCadence: wireClock({ setByParticipantId: ME }) }), context)).toBe(
      'ignored',
    );
  });

  it('cannot tell another member from itself without its own id, so it takes nothing unarmed', () => {
    expect(handleCrewCadenceChange(change(), { ...context, ownParticipantId: null })).toBe('ignored');
  });
});

describe('handleCrewCadenceChange: the clock going off', () => {
  it('turns this phone’s timer off when the crew turns its clock off', () => {
    handleCrewCadenceChange(change(), context);
    expect(handleCrewCadenceChange(change({ revision: 11, restCadence: null, action: 'DISARM' }), context)).toBe(
      'cleared',
    );
    expect(getRestTimerState().armed).toBe(false);
    expect(getRestTimerState().crew).toBeNull();
  });

  it('leaves alone a timer armed here whose ARM has not reached the server yet', () => {
    armRestTimer('onTheMinute', T0, SESSION);
    expect(handleCrewCadenceChange(change({ restCadence: null, isSnapshot: true, action: null }), context)).toBe(
      'ignored',
    );
    expect(getRestTimerState().armed).toBe(true);
  });
});

describe('handleCrewCadenceChange: an unsupported clock', () => {
  it('is held without touching the timer, so nothing fires on it', () => {
    armRestTimer('afterTick', T0, SESSION);
    const before = getRestTimerState();
    expect(handleCrewCadenceChange(change({ restCadence: wireClock({ mode: 'everyOtherMinute' }) }), context)).toBe(
      'unsupported',
    );
    const after = getRestTimerState();
    expect(after.crew?.config).toBeNull();
    expect(after.anchorMs).toBe(before.anchorMs);
  });
});

describe('the subscribe seed', () => {
  it('tells listeners and remembers whether the server had a clock', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCrewCadenceSnapshots(listener);
    handleCrewCadenceChange(change({ restCadence: null, isSnapshot: true, action: null, revision: 0 }), context);
    expect(listener).toHaveBeenCalledWith({ sessionId: SESSION, hasClock: false });
    expect(getLastCrewCadenceSnapshot()).toEqual({ sessionId: SESSION, hasClock: false });
    unsubscribe();
    handleCrewCadenceChange(change({ isSnapshot: true, action: null }), context);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getLastCrewCadenceSnapshot()).toEqual({ sessionId: SESSION, hasClock: true });
  });

  it('is not a live change', () => {
    const listener = vi.fn();
    subscribeCrewCadenceSnapshots(listener);
    handleCrewCadenceChange(change(), context);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('inputs', () => {
  it('clamps a rest length into the server’s bounds for the mode', () => {
    expect(toCrewConfigInput({ ...ownSettings, targetSeconds: 5 }).targetSeconds).toBe(10);
    expect(toCrewConfigInput({ ...ownSettings, mode: 'onTheMinute', targetSeconds: 10 }).targetSeconds).toBe(15);
    expect(toCrewConfigInput({ ...ownSettings, targetSeconds: 9_000 }).targetSeconds).toBe(3600);
    expect(toCrewConfigInput({ ...ownSettings, targetSeconds: null }).targetSeconds).toBeNull();
    expect(toCrewConfigInput({ ...ownSettings, targetSeconds: 62.4 }).targetSeconds).toBe(62);
  });

  it('arms counting from where this phone already is, or waiting when it waits', () => {
    armRestTimer('onTheMinute', T0, SESSION);
    expect(buildArmInput(ownSettings, getRestTimerState(), T0 + 1_500)).toEqual({
      action: 'ARM',
      config: toCrewConfigInput(ownSettings),
      elapsedMs: 1_500,
    });
    armRestTimer('afterTick', T0, SESSION);
    expect(buildArmInput(ownSettings, getRestTimerState(), T0)).toEqual({
      action: 'ARM',
      config: toCrewConfigInput(ownSettings),
    });
  });

  it('restarts a deadline rest with RESET, and a tick or send rest without forgetting its tick', () => {
    armRestTimer('afterTick', T0, SESSION);
    const state = { ...getRestTimerState(), anchorMs: T0 };
    expect(buildRestartInput(ownSettings, state, T0)).toEqual({ action: 'RESET', isRunning: true });
    expect(buildRestartInput({ ...ownSettings, advanceOn: 'send' }, state, T0 + 400)).toEqual({
      action: 'CONFIGURE',
      config: toCrewConfigInput({ ...ownSettings, advanceOn: 'send' }),
      anchor: 'NOW',
      elapsedMs: 400,
    });
  });

  it('sends nothing for a CONFIGURE that changes nothing', () => {
    armRestTimer('afterTick', T0, SESSION);
    const configure = (anchor: 'KEEP' | 'NOW' | 'CLEAR', previous: OwnRestPacing | null) =>
      buildConfigureInput({
        own: ownSettings,
        previous,
        anchor,
        boundaryAtMs: null,
        state: getRestTimerState(),
        nowMs: T0,
      });
    expect(configure('KEEP', ownSettings)).toBeNull();
    expect(configure('KEEP', { ...ownSettings, targetSeconds: 60 })).toMatchObject({
      action: 'CONFIGURE',
      anchor: 'KEEP',
    });
    expect(configure('KEEP', null)).toMatchObject({ action: 'CONFIGURE', anchor: 'KEEP' });
  });

  it('moves the anchor when the mode changes, whatever was asked', () => {
    armRestTimer('afterTick', T0, SESSION);
    const fromOnTheMinute = buildConfigureInput({
      own: ownSettings,
      previous: { ...ownSettings, mode: 'onTheMinute' },
      anchor: 'KEEP',
      boundaryAtMs: null,
      state: getRestTimerState(),
      nowMs: T0,
    });
    expect(fromOnTheMinute).toMatchObject({ anchor: 'CLEAR' });
    const intoOnTheMinute = buildConfigureInput({
      own: { ...ownSettings, mode: 'onTheMinute' },
      previous: ownSettings,
      anchor: 'KEEP',
      boundaryAtMs: null,
      state: getRestTimerState(),
      nowMs: T0,
    });
    expect(intoOnTheMinute).toMatchObject({ anchor: 'NOW', elapsedMs: 0 });
  });

  it('counts a stage boundary’s NOW from the anchor this phone already moved, sent after the debounce', () => {
    // The stage boundary moved this phone's beat to T0; the CONFIGURE goes out 400 ms later.
    armRestTimer('onTheMinute', T0, SESSION);
    expect(
      buildConfigureInput({
        own: { ...ownSettings, mode: 'onTheMinute', source: 'stage' },
        previous: ownSettings,
        anchor: 'NOW',
        boundaryAtMs: T0,
        state: getRestTimerState(),
        nowMs: T0 + 400,
      }),
    ).toMatchObject({ anchor: 'NOW', elapsedMs: 400 });
  });

  it('counts a stage boundary’s NOW from the boundary even when a crew change replaced the anchor meanwhile', () => {
    // The beat moved to T0 here; a crewmate's change put the timer back on an older anchor before the send.
    armRestTimer('onTheMinute', T0 - 50_000, SESSION);
    expect(
      buildConfigureInput({
        own: { ...ownSettings, mode: 'onTheMinute', source: 'stage' },
        previous: { ...ownSettings, mode: 'onTheMinute', targetSeconds: 120 },
        anchor: 'NOW',
        boundaryAtMs: T0,
        state: getRestTimerState(),
        nowMs: T0 + 400,
      }),
    ).toMatchObject({ anchor: 'NOW', elapsedMs: 400 });
  });

  it('starts the beat now when entering on the minute on a clock whose mode it cannot tell', () => {
    armRestTimer('afterTick', T0, SESSION);
    expect(
      buildConfigureInput({
        own: { ...ownSettings, mode: 'onTheMinute' },
        previous: null,
        anchor: 'KEEP',
        boundaryAtMs: null,
        state: getRestTimerState(),
        nowMs: T0,
      }),
    ).toMatchObject({ anchor: 'NOW', elapsedMs: 0 });
  });

  it('dates a TICK by how long ago the climb was logged', () => {
    expect(buildTickInput({ status: 'flash', queueItemUuid: 'item-1' }, T0, T0 + 2_500)).toEqual({
      action: 'TICK',
      tickStatus: 'flash',
      tickQueueItemUuid: 'item-1',
      elapsedMs: 2_500,
    });
  });

  it('dates a TICK from history by its own climbedAt, never clamped to a minute, up to the 4 h wire bound', () => {
    const tick = { status: 'send' as const, queueItemUuid: 'item-1' };
    // Two hours back: the server needs the real age to apply its history rule (#6754).
    expect(buildTickInput(tick, T0, T0 + 2 * 60 * 60 * 1000).elapsedMs).toBe(7_200_000);
    // Past 4 h the server's validation would refuse it, so it is capped there.
    expect(buildTickInput(tick, T0, T0 + 5 * 60 * 60 * 1000).elapsedMs).toBe(14_400_000);
    // A climbedAt from a clock ahead of this phone's is from now.
    expect(buildTickInput(tick, T0 + 3_000, T0).elapsedMs).toBe(0);
  });
});

describe('crewBeatServerMs', () => {
  it('is one rest past the server’s anchor after a tick', () => {
    const crew = parseCrewRestCadence(SESSION, 1, wireClock());
    expect(crewBeatServerMs(crew, T0 + 59_000)).toBe(T0 + 60_000);
  });

  it('is the grid beat nearest the local deadline on the minute', () => {
    const crew = parseCrewRestCadence(SESSION, 1, wireClock({ mode: 'onTheMinute', targetSeconds: 60 }));
    expect(crewBeatServerMs(crew, T0 + 179_400)).toBe(T0 + 180_000);
    expect(crewBeatServerMs(crew, T0 + 10_000)).toBe(T0 + 60_000);
  });

  it('has no beat without an anchor, a rest length or a config', () => {
    expect(crewBeatServerMs(parseCrewRestCadence(SESSION, 1, wireClock({ anchorAt: null })), T0)).toBeNull();
    expect(crewBeatServerMs(parseCrewRestCadence(SESSION, 1, wireClock({ targetSeconds: null })), T0)).toBeNull();
    expect(crewBeatServerMs(parseCrewRestCadence(SESSION, 1, wireClock({ mode: 'later' })), T0)).toBeNull();
  });
});

describe('planCrewFireOutcome', () => {
  const beatServerMs = T0 + 60_000;
  const reply = (overrides: Partial<SessionRestCadenceChangeWire> = {}, clock: Partial<SessionRestCadenceWire> = {}) =>
    change({ serverNow: String(beatServerMs), action: null, ...overrides, restCadence: wireClock(clock) });

  it('moves the wall only when the server took the beat', () => {
    expect(planCrewFireOutcome({ applied: true, change: reply(), beatServerMs, attempt: 0 })).toEqual({
      kind: 'advance',
    });
  });

  it('leaves a beat someone else already took', () => {
    expect(
      planCrewFireOutcome({
        applied: false,
        change: reply({}, { lastFiredBeatAt: String(beatServerMs) }),
        beatServerMs,
        attempt: 0,
      }),
    ).toEqual({ kind: 'claimed' });
  });

  it.each([
    ['paused', { isRunning: false }],
    ['auto-advance off', { autoAdvance: false }],
    ['re-anchored by a tick', { anchorAt: String(T0 + 30_000) }],
    ['waiting for a tick', { anchorAt: null }],
    ['a different rest', { targetSeconds: 90 }],
  ])('drops a beat the clock no longer has (%s)', (_label, clock) => {
    expect(planCrewFireOutcome({ applied: false, change: reply({}, clock), beatServerMs, attempt: 0 })).toEqual({
      kind: 'refused',
    });
  });

  it('skips the retry for a beat the server’s spacing fence refuses, and retries one it does not', () => {
    // After a tick: the last advance 10 s after the anchor, so this deadline is 50 s after it (< 60 − 3).
    expect(
      planCrewFireOutcome({
        applied: false,
        change: reply({ serverNow: String(beatServerMs - 2_500) }, { lastFiredBeatAt: String(T0 + 10_000) }),
        beatServerMs,
        attempt: 0,
      }),
    ).toEqual({ kind: 'refused' });
    // 57 s after the last advance is a whole rest less the 3 s slack: not fenced, so "not due yet" retries.
    expect(
      planCrewFireOutcome({
        applied: false,
        change: reply({ serverNow: String(beatServerMs - 2_500) }, { lastFiredBeatAt: String(T0 + 3_000) }),
        beatServerMs,
        attempt: 0,
      }),
    ).toEqual({ kind: 'retry', atServerMs: beatServerMs });
  });

  it('pins the fence to the server’s numbers', () => {
    expect(crewBeatFenced({ mode: 'afterTick', targetSeconds: 60 }, T0, T0 + 56_999)).toBe(true);
    expect(crewBeatFenced({ mode: 'afterTick', targetSeconds: 60 }, T0, T0 + 57_000)).toBe(false);
    expect(crewBeatFenced({ mode: 'onTheMinute', targetSeconds: 60 }, T0, T0 + 11_999)).toBe(true);
    expect(crewBeatFenced({ mode: 'onTheMinute', targetSeconds: 60 }, T0, T0 + 12_000)).toBe(false);
    expect(crewBeatFenced({ mode: 'afterTick', targetSeconds: 60 }, null, T0)).toBe(false);
  });

  it('drops it when the crew turned the clock off', () => {
    expect(
      planCrewFireOutcome({ applied: false, change: { ...reply(), restCadence: null }, beatServerMs, attempt: 0 }),
    ).toEqual({ kind: 'refused' });
  });

  it('retries at the beat when the server’s clock had not reached its window yet', () => {
    const early = reply({ serverNow: String(beatServerMs - CREW_FIRE_EARLY_TOLERANCE_MS - 500) });
    expect(planCrewFireOutcome({ applied: false, change: early, beatServerMs, attempt: 0 })).toEqual({
      kind: 'retry',
      atServerMs: beatServerMs,
    });
  });

  it('retries at once when another write moved the revision inside the window', () => {
    const raced = reply({ revision: 11, serverNow: String(beatServerMs + 400) }, { lastTickStatus: 'send' });
    expect(planCrewFireOutcome({ applied: false, change: raced, beatServerMs, attempt: 0 })).toEqual({
      kind: 'retry',
      atServerMs: beatServerMs + 400,
    });
  });

  it('gives up after the retries', () => {
    const raced = reply({ serverNow: String(beatServerMs + 400) });
    expect(
      planCrewFireOutcome({ applied: false, change: raced, beatServerMs, attempt: MAX_CREW_FIRE_RETRIES }),
    ).toEqual({ kind: 'refused' });
  });

  it('calls a beat more than 5 s gone by the server’s clock lost', () => {
    const late = reply({ serverNow: String(beatServerMs + CREW_FIRE_LATE_TOLERANCE_MS + 1) });
    expect(planCrewFireOutcome({ applied: false, change: late, beatServerMs, attempt: 0 })).toEqual({ kind: 'lost' });
  });

  it('keeps an on-the-minute beat that is still on the grid', () => {
    const onTheMinute = reply(
      { serverNow: String(T0 + 180_300), revision: 12 },
      { mode: 'onTheMinute', lastFiredBeatAt: String(T0 + 120_000) },
    );
    expect(
      planCrewFireOutcome({ applied: false, change: onTheMinute, beatServerMs: T0 + 180_000, attempt: 0 }),
    ).toEqual({ kind: 'retry', atServerMs: T0 + 180_300 });
    expect(
      planCrewFireOutcome({ applied: false, change: onTheMinute, beatServerMs: T0 + 120_000, attempt: 0 }),
    ).toEqual({ kind: 'claimed' });
    // Off the grid is not this clock's beat at all.
    expect(
      planCrewFireOutcome({ applied: false, change: onTheMinute, beatServerMs: T0 + 170_000, attempt: 0 }),
    ).toEqual({ kind: 'refused' });
  });
});

// A 4x4 set rest on the crew clock (#5382, #5380): the server moves the wall
// once and then turns auto-advance off. The flag rides in the config, so every
// CONFIGURE this phone re-sends from the clock it holds keeps it, and nothing
// else ever sends it.
describe('a once-only advance (autoAdvanceOnce)', () => {
  /** The set rest after a 4x4 set's last rep, as the builder's phone sends it. */
  const setRest: OwnRestPacing = {
    mode: 'afterTick',
    targetSeconds: 180,
    autoAdvance: true,
    autoAdvanceOnce: true,
    advanceOn: 'tick',
    source: 'stage',
  };
  const setRestWire = wireClock({ targetSeconds: 180, advanceOn: 'tick', source: 'stage', autoAdvanceOnce: true });

  it('reads it from the wire, and a server that sends none, or false, as no once-only advance', () => {
    expect(parseCrewRestCadence(SESSION, 1, setRestWire).config).toMatchObject({ autoAdvanceOnce: true });
    expect(parseCrewRestCadence(SESSION, 1, wireClock({ autoAdvanceOnce: false })).config).not.toHaveProperty(
      'autoAdvanceOnce',
    );
    expect(parseCrewRestCadence(SESSION, 1, wireClock({ autoAdvanceOnce: null })).config).not.toHaveProperty(
      'autoAdvanceOnce',
    );
    expect(parseCrewRestCadence(SESSION, 1, wireClock()).config).not.toHaveProperty('autoAdvanceOnce');
    // Without auto-advance no FIRE applies, so it means nothing: never revived by a later edit.
    expect(
      parseCrewRestCadence(SESSION, 1, wireClock({ autoAdvance: false, autoAdvanceOnce: true })).config,
    ).not.toHaveProperty('autoAdvanceOnce');
  });

  it('keeps it on the clock this phone follows, so the scheduler and the publisher see it', () => {
    armRestTimer('afterTick', T0, SESSION);
    handleCrewCadenceChange(change({ restCadence: setRestWire }), context);
    expect(getRestTimerState().crew?.config).toMatchObject({ autoAdvance: true, autoAdvanceOnce: true });

    // The FIRE that took the beat spent it: the same clock, auto-advance off.
    handleCrewCadenceChange(
      change({
        revision: 11,
        action: 'FIRE',
        restCadence: { ...setRestWire, autoAdvance: false, autoAdvanceOnce: false },
      }),
      context,
    );
    expect(getRestTimerState().crew?.config).toMatchObject({ autoAdvance: false });
    expect(getRestTimerState().crew?.config).not.toHaveProperty('autoAdvanceOnce');
  });

  it('sends it only with auto-advance on, and leaves it out of every other config', () => {
    expect(toCrewConfigInput(setRest)).toEqual({
      mode: 'afterTick',
      targetSeconds: 180,
      autoAdvance: true,
      autoAdvanceOnce: true,
      advanceOn: 'tick',
      source: 'stage',
    });
    // Off moves nothing, so a once-only flag on it means nothing either.
    expect(toCrewConfigInput({ ...setRest, autoAdvance: false })).not.toHaveProperty('autoAdvanceOnce');
    // Every config without it goes out exactly as before the flag.
    expect(Object.keys(toCrewConfigInput(ownSettings))).toEqual([
      'mode',
      'targetSeconds',
      'autoAdvance',
      'advanceOn',
      'source',
    ]);
  });

  it('counts it as a change of config, and the same config with it as none', () => {
    const { autoAdvanceOnce: _once, ...everyRest } = setRest;
    expect(sameCrewConfig(setRest, everyRest)).toBe(false);
    expect(sameCrewConfig(setRest, { ...setRest })).toBe(true);

    armRestTimer('afterTick', T0, SESSION);
    const configure = (own: OwnRestPacing, previous: OwnRestPacing) =>
      buildConfigureInput({ own, previous, anchor: 'KEEP', boundaryAtMs: null, state: getRestTimerState(), nowMs: T0 });
    // The set's last rep: the clock held "advance on every rest"; the set rest goes out once-only.
    expect(configure(setRest, everyRest)).toEqual({
      action: 'CONFIGURE',
      config: toCrewConfigInput(setRest),
      anchor: 'KEEP',
    });
    expect(configure(setRest, setRest)).toBeNull();
    // A limit block after it: the flag goes, and the server clears it.
    expect(configure({ ...everyRest, advanceOn: 'send' }, setRest)).toEqual({
      action: 'CONFIGURE',
      config: { mode: 'afterTick', targetSeconds: 180, autoAdvance: true, advanceOn: 'send', source: 'stage' },
      anchor: 'KEEP',
    });
  });

  it('keeps it in the CONFIGURE that restarts a set rest, and sends none without it', () => {
    armRestTimer('afterTick', T0, SESSION);
    const state = { ...getRestTimerState(), anchorMs: T0 };
    expect(buildRestartInput(setRest, state, T0 + 400)).toEqual({
      action: 'CONFIGURE',
      config: toCrewConfigInput(setRest),
      anchor: 'NOW',
      elapsedMs: 400,
    });
    const { autoAdvanceOnce: _once, ...everyRest } = setRest;
    const restart = buildRestartInput(everyRest, state, T0 + 400);
    expect(restart).toMatchObject({ action: 'CONFIGURE', anchor: 'NOW' });
    expect(restart.config).not.toHaveProperty('autoAdvanceOnce');
  });

  it('is spent by a move this phone made itself, and nothing else changes', () => {
    expect(spendAdvanceOnce(setRest)).toEqual({
      mode: 'afterTick',
      targetSeconds: 180,
      autoAdvance: false,
      advanceOn: 'tick',
      source: 'stage',
    });
    expect(spendAdvanceOnce(ownSettings)).toBe(ownSettings);
  });

  it('stays through a crew rest-length edit, and goes when the edit turns auto-advance off', () => {
    armRestTimer('afterTick', T0, SESSION);
    handleCrewCadenceChange(change({ restCadence: setRestWire }), context);

    expect(editCrewRestPacing({ targetSeconds: 240 })).toBe(true);
    expect(getRestTimerState().crewPacingDraft).toEqual({
      mode: 'afterTick',
      targetSeconds: 240,
      autoAdvance: true,
      autoAdvanceOnce: true,
      advanceOn: 'tick',
      source: 'settings',
      setByParticipantId: SAM,
    });

    expect(editCrewRestPacing({ autoAdvance: false })).toBe(true);
    expect(getRestTimerState().crewPacingDraft).toMatchObject({ targetSeconds: 240, autoAdvance: false });
    expect(getRestTimerState().crewPacingDraft).not.toHaveProperty('autoAdvanceOnce');
  });

  it('is not put back by a rest-length edit that goes out after the server spent or cleared it', () => {
    const editedSetRest = { ...setRest, targetSeconds: 240, source: 'settings' as const };
    const spent = spendAdvanceOnce(setRest);
    const { autoAdvanceOnce: _once, ...everyRest } = setRest;

    // The holder's FIRE spent it after the tap: the edit keeps its length, auto-advance stays off.
    expect(rebaseCrewPacingDraft(editedSetRest, spent)).toEqual({
      mode: 'afterTick',
      targetSeconds: 240,
      autoAdvance: false,
      advanceOn: 'tick',
      source: 'settings',
    });
    expect(buildCrewPacingEditInput({ draft: editedSetRest, held: spent })).toEqual({
      input: {
        action: 'CONFIGURE',
        config: { mode: 'afterTick', targetSeconds: 240, autoAdvance: false, advanceOn: 'tick', source: 'settings' },
        anchor: 'KEEP',
      },
      config: { mode: 'afterTick', targetSeconds: 240, autoAdvance: false, advanceOn: 'tick', source: 'settings' },
    });
    // A CONFIGURE cleared it but left auto-advance on: the edit takes that clock's auto-advance.
    expect(rebaseCrewPacingDraft(editedSetRest, everyRest)).toEqual({
      ...everyRest,
      targetSeconds: 240,
      source: 'settings',
    });
    // The server still holds it: the edit goes out with it, as tapped.
    expect(rebaseCrewPacingDraft(editedSetRest, setRest)).toBe(editedSetRest);
    // A draft without it, or no held clock to compare with, goes out as it is.
    const editedEveryRest = { ...everyRest, targetSeconds: 240 };
    expect(rebaseCrewPacingDraft(editedEveryRest, spent)).toBe(editedEveryRest);
    expect(rebaseCrewPacingDraft(editedSetRest, null)).toBe(editedSetRest);
    // Nothing left to send when the rebased edit is what the server holds.
    expect(
      buildCrewPacingEditInput({ draft: { ...setRest, source: 'settings' }, held: { ...spent, source: 'settings' } }),
    ).toBeNull();
  });
});
