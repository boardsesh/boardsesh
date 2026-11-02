// What this phone sends to the crew's shared clock, and when (#5382).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SessionRestCadence,
  SessionRestCadenceInput,
  SetSessionRestCadencePayload,
} from '@boardsesh/shared-schema/generated';
import {
  editCrewRestPacing,
  handleCrewCadenceChange,
  resetCrewCadenceForTests,
  toCrewConfigInput,
  type CrewRestCadence,
  type OwnRestPacing,
} from '../crew-rest-cadence';
import { CREW_CONFIGURE_DEBOUNCE_MS, createCrewRestPublisher, type CrewRestPublisher } from '../crew-rest-publisher';
import {
  adoptCrewCadence,
  applyRestTimerStagePacing,
  armRestTimer,
  bindRestTimerToSession,
  clearRestTimerQueueEnded,
  disarmRestTimer,
  getRestTimerState,
  noteRestTimerAutoAdvanceFired,
  noteRestTimerQueueEnded,
  noteRestTimerTick,
  pauseRestTimer,
  reanchorRestTimerAfterBackground,
  resetRestTimer,
  resetRestTimerStoreForTests,
  resumeRestTimer,
  subscribeLocalRestTimerActions,
} from '../rest-timer-store';
import { resetServerClock } from '../server-clock';
import { resolveEffectiveRestPacing } from '../rest-timer-pacing';

const SESSION = 'session-1';
const ME = 'participant-me';
const T0 = Date.parse('2026-10-24T10:00:00.000Z');

let currentNowMs = T0;
let own: OwnRestPacing;
let sent: SessionRestCadenceInput[];
let pendingReplies: Array<{
  resolve: (payload: SetSessionRestCadencePayload | null) => void;
  reject: (error: unknown) => void;
}>;
let autoReply: boolean;
let revision: number;
const report = vi.fn();
let publisher: CrewRestPublisher;
let unsubscribe: () => void;

function reply(applied = true): SetSessionRestCadencePayload {
  revision += 1;
  return {
    applied,
    change: { restCadence: null, revision, serverNow: String(currentNowMs), isSnapshot: false, action: null },
  };
}

async function flush() {
  // Let the publisher's queued sends and their replies settle.
  for (let round = 0; round < 10; round++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  resetRestTimerStoreForTests();
  resetCrewCadenceForTests();
  resetServerClock();
  report.mockClear();
  currentNowMs = T0;
  revision = 100;
  sent = [];
  pendingReplies = [];
  autoReply = true;
  own = { mode: 'afterTick', targetSeconds: 90, autoAdvance: true, advanceOn: 'deadline', source: 'settings' };
  publisher = createCrewRestPublisher({
    sessionId: SESSION,
    send: (input) => {
      sent.push(input);
      if (autoReply) return Promise.resolve(reply());
      return new Promise((resolve, reject) => pendingReplies.push({ resolve, reject }));
    },
    getOwnParticipantId: () => ME,
    getState: getRestTimerState,
    getOwnPacing: () => own,
    nowMs: () => currentNowMs,
    report,
  });
  unsubscribe = subscribeLocalRestTimerActions(publisher.handleLocalAction);
});

afterEach(() => {
  unsubscribe();
  publisher.dispose();
  vi.useRealTimers();
});

describe('arm and disarm', () => {
  it('arms the crew clock with this phone’s own pacing', async () => {
    armRestTimer('afterTick', currentNowMs, SESSION);
    await flush();
    expect(sent).toEqual([{ action: 'ARM', config: toCrewConfigInput(own) }]);
  });

  it('counts an on-the-minute arm from where its beat already is', async () => {
    armRestTimer('onTheMinute', currentNowMs, SESSION);
    await flush();
    expect(sent).toEqual([{ action: 'ARM', config: toCrewConfigInput(own), elapsedMs: 0 }]);
  });

  it('turns the crew clock off with the timer', async () => {
    armRestTimer('afterTick', currentNowMs, SESSION);
    disarmRestTimer();
    await flush();
    expect(sent.map((input) => input.action)).toEqual(['ARM', 'DISARM']);
  });

  it('never sends an action from another session into this one', async () => {
    armRestTimer('afterTick', currentNowMs, 'session-old');
    disarmRestTimer();
    await flush();
    expect(sent).toEqual([]);
  });

  it('keeps a clock this phone set off on the next seed once the climber turned it off here', async () => {
    armRestTimer('afterTick', currentNowMs, SESSION);
    disarmRestTimer();
    await flush();
    const seed = {
      restCadence: {
        mode: 'afterTick',
        targetSeconds: 90,
        autoAdvance: true,
        advanceOn: 'deadline',
        source: 'settings',
        isRunning: true,
        anchorAt: String(T0),
        pausedElapsedSeconds: 0,
        lastFiredBeatAt: null,
        lastTickQueueItemUuid: null,
        lastTickStatus: null,
        setByParticipantId: ME,
      },
      revision: 500,
      serverNow: String(T0),
      isSnapshot: true,
      action: null,
    };
    const context = { sessionId: SESSION, ownParticipantId: ME, receivedAtMs: T0 };
    expect(handleCrewCadenceChange(seed, context)).toBe('ignored');
    expect(getRestTimerState().armed).toBe(false);

    // Turned on again here, then the timer state went (as after a crash):
    // the next seed brings the clock this phone set back.
    armRestTimer('afterTick', currentNowMs, SESSION);
    await flush();
    resetRestTimerStoreForTests();
    expect(handleCrewCadenceChange({ ...seed, revision: 600 }, context)).toBe('adopted');
    expect(getRestTimerState().armed).toBe(true);
  });
});

describe('ticks', () => {
  it('sends a tick from history with its real age, so the server applies its own history rule', async () => {
    armRestTimer('afterTick', currentNowMs, SESSION);
    await flush();
    sent.length = 0;
    currentNowMs = T0 + 2 * 60 * 60 * 1000;
    noteRestTimerTick(new Date(T0).toISOString(), 'afterTick', currentNowMs, {
      status: 'send',
      queueItemUuid: 'item-1',
    });
    await flush();
    expect(sent).toEqual([{ action: 'TICK', tickStatus: 'send', tickQueueItemUuid: 'item-1', elapsedMs: 7_200_000 }]);
  });

  it('sends a tick with its queue item, how it went, and how long ago it was', async () => {
    armRestTimer('afterTick', currentNowMs, SESSION);
    await flush();
    sent.length = 0;
    currentNowMs = T0 + 3_000;
    noteRestTimerTick(new Date(T0 + 1_000).toISOString(), 'afterTick', currentNowMs, {
      status: 'flash',
      queueItemUuid: 'item-1',
    });
    await flush();
    expect(sent).toEqual([{ action: 'TICK', tickStatus: 'flash', tickQueueItemUuid: 'item-1', elapsedMs: 2_000 }]);
  });

  it('sends nothing for a tick read back from the session after a cold start', async () => {
    armRestTimer('afterTick', currentNowMs, SESSION);
    await flush();
    sent.length = 0;
    noteRestTimerTick(new Date(T0).toISOString(), 'afterTick', currentNowMs);
    await flush();
    expect(sent).toEqual([]);
  });

  it('keeps a late tick on another climb off the crew clock under a tick or send rule', async () => {
    adoptCrewCadence({
      sessionId: SESSION,
      revision: 3,
      config: {
        mode: 'afterTick',
        targetSeconds: 180,
        autoAdvance: true,
        advanceOn: 'send',
        source: 'stage',
        setByParticipantId: 'participant-sam',
      },
      isRunning: true,
      anchorMs: T0,
      pausedElapsedSeconds: 0,
      lastFiredBeatMs: null,
      lastTick: { status: 'send', queueItemUuid: 'item-wall' },
      anchorServerMs: T0,
      lastFiredBeatServerMs: null,
    });
    applyRestTimerStagePacing(
      {
        sessionId: SESSION,
        stageId: 'limit',
        kind: 'limitBouldering',
        queueItemUuid: 'item-wall',
        mode: 'afterTick',
        targetSeconds: 180,
        advanceOn: 'send',
        closesSet: false,
        stagePacing: { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' },
      },
      currentNowMs,
      'none',
    );
    await flush();
    sent.length = 0;
    noteRestTimerTick(new Date(T0).toISOString(), 'afterTick', currentNowMs, {
      status: 'attempt',
      queueItemUuid: 'item-previous',
    });
    await flush();
    expect(sent.filter((input) => input.action === 'TICK')).toEqual([]);
  });
});

describe('pause, resume, reset, restarts', () => {
  beforeEach(async () => {
    armRestTimer('afterTick', currentNowMs, SESSION);
    noteRestTimerTick(new Date(T0).toISOString(), 'afterTick', currentNowMs, { status: 'send', queueItemUuid: null });
    await flush();
    sent.length = 0;
  });

  it('sends each in order', async () => {
    pauseRestTimer(T0 + 12_000);
    resumeRestTimer(T0 + 20_000);
    resetRestTimer(T0 + 30_000);
    await flush();
    expect(sent).toEqual([
      { action: 'PAUSE', pausedElapsedSeconds: 12 },
      { action: 'RESUME' },
      { action: 'RESET', isRunning: true },
    ]);
  });

  it('restarts a deadline rest from the background with RESET', async () => {
    reanchorRestTimerAfterBackground(T0 + 120_000, T0 + 90_000);
    await flush();
    expect(sent).toEqual([{ action: 'RESET', isRunning: true }]);
  });

  it('restarts a crew rest under a tick rule with CONFIGURE anchor NOW on the crew’s config, keeping its tick', async () => {
    adoptCrewCadence({
      sessionId: SESSION,
      revision: 3,
      config: {
        mode: 'afterTick',
        targetSeconds: 180,
        autoAdvance: true,
        advanceOn: 'send',
        source: 'stage',
        setByParticipantId: 'participant-sam',
      },
      isRunning: true,
      anchorMs: T0,
      pausedElapsedSeconds: 0,
      lastFiredBeatMs: null,
      lastTick: { status: 'send', queueItemUuid: 'item-wall' },
      anchorServerMs: T0,
      lastFiredBeatServerMs: null,
    });
    sent.length = 0;
    currentNowMs = T0 + 200_000;
    reanchorRestTimerAfterBackground(currentNowMs, T0 + 180_000);
    await flush();
    expect(sent).toEqual([
      {
        action: 'CONFIGURE',
        config: { mode: 'afterTick', targetSeconds: 180, autoAdvance: true, advanceOn: 'send', source: 'stage' },
        anchor: 'NOW',
        elapsedMs: 0,
      },
    ]);
  });

  it('keeps the server’s rest in step when this phone moved the wall itself', async () => {
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'afterTick', T0 + 90_000, T0 + 90_000);
    await flush();
    expect(sent).toEqual([{ action: 'RESET', isRunning: true }]);
  });

  it('waits for the next tick on the server too under a tick rule', async () => {
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'afterTick', T0 + 90_000, T0 + 90_000, 'clear');
    await flush();
    expect(sent).toEqual([{ action: 'CONFIGURE', config: toCrewConfigInput(own), anchor: 'CLEAR' }]);
  });

  it('sends nothing for a beat that kept its anchor', async () => {
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'onTheMinute', T0 + 90_000, T0 + 90_000, 'keep');
    await flush();
    expect(sent).toEqual([]);
  });

  it('sends one at a time, the next only once the last is answered', async () => {
    autoReply = false;
    pauseRestTimer(T0 + 12_000);
    resumeRestTimer(T0 + 20_000);
    await flush();
    expect(sent.map((input) => input.action)).toEqual(['PAUSE']);
    pendingReplies.shift()?.resolve(reply());
    await flush();
    expect(sent.map((input) => input.action)).toEqual(['PAUSE', 'RESUME']);
  });

  it('reports a failed send and carries on with the next', async () => {
    autoReply = false;
    pauseRestTimer(T0 + 12_000);
    resumeRestTimer(T0 + 20_000);
    await flush();
    pendingReplies.shift()?.reject(new Error('socket closed'));
    await flush();
    expect(report).toHaveBeenCalledWith(expect.any(Error), 'PAUSE');
    expect(sent.map((input) => input.action)).toEqual(['PAUSE', 'RESUME']);
  });
});

describe('CONFIGURE', () => {
  beforeEach(async () => {
    armRestTimer('afterTick', currentNowMs, SESSION);
    await flush();
    sent.length = 0;
  });

  it('waits 400 ms and sends one for a run of settings edits', async () => {
    own = { ...own, targetSeconds: 120 };
    publisher.noteSettingsEdited();
    vi.advanceTimersByTime(CREW_CONFIGURE_DEBOUNCE_MS - 100);
    own = { ...own, targetSeconds: 150 };
    publisher.noteSettingsEdited();
    vi.advanceTimersByTime(CREW_CONFIGURE_DEBOUNCE_MS - 1);
    await flush();
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    await flush();
    expect(sent).toEqual([{ action: 'CONFIGURE', config: toCrewConfigInput(own), anchor: 'KEEP' }]);
  });

  it('sends nothing when the clock already runs on this pacing', async () => {
    publisher.noteSettingsEdited();
    vi.advanceTimersByTime(CREW_CONFIGURE_DEBOUNCE_MS);
    await flush();
    expect(sent).toEqual([]);
  });

  it('sends nothing for a settings edit while the timer is off', async () => {
    disarmRestTimer();
    await flush();
    sent.length = 0;
    own = { ...own, targetSeconds: 120 };
    publisher.noteSettingsEdited();
    vi.advanceTimersByTime(CREW_CONFIGURE_DEBOUNCE_MS);
    await flush();
    expect(sent).toEqual([]);
  });

  it('starts an on-the-minute stage’s beat where this phone started it', async () => {
    own = { mode: 'onTheMinute', targetSeconds: 60, autoAdvance: true, advanceOn: 'deadline', source: 'stage' };
    applyRestTimerStagePacing(
      {
        sessionId: SESSION,
        stageId: 'emom',
        kind: 'onTheMinute',
        queueItemUuid: 'item-1',
        mode: 'onTheMinute',
        targetSeconds: 60,
        advanceOn: 'deadline',
        closesSet: false,
        stagePacing: { mode: 'onTheMinute', restSeconds: 60 },
      },
      currentNowMs,
      'anchorNow',
    );
    currentNowMs += CREW_CONFIGURE_DEBOUNCE_MS;
    vi.advanceTimersByTime(CREW_CONFIGURE_DEBOUNCE_MS);
    await flush();
    expect(sent).toEqual([
      { action: 'CONFIGURE', config: toCrewConfigInput(own), anchor: 'NOW', elapsedMs: CREW_CONFIGURE_DEBOUNCE_MS },
    ]);
  });

  it('keeps a stage boundary’s anchor when a plain edit lands in the same window', async () => {
    own = { ...own, advanceOn: 'tick', source: 'stage' };
    applyRestTimerStagePacing(
      {
        sessionId: SESSION,
        stageId: 'four',
        kind: 'fourByFour',
        queueItemUuid: 'item-1',
        mode: 'afterTick',
        targetSeconds: null,
        advanceOn: 'tick',
        closesSet: false,
        reps: { logged: 0, perSet: 4 },
        stagePacing: {
          mode: 'afterTick',
          restSeconds: 0,
          advanceOn: 'set',
          sets: { repsPerSet: 4, restBetweenSetsSeconds: 180 },
        },
      },
      currentNowMs,
      'waitForTick',
    );
    publisher.noteSettingsEdited();
    vi.advanceTimersByTime(CREW_CONFIGURE_DEBOUNCE_MS);
    await flush();
    expect(sent).toEqual([{ action: 'CONFIGURE', config: toCrewConfigInput(own), anchor: 'CLEAR' }]);
  });

  it('keeps a 4x4 set’s crew clock from moving the wall until the set’s last rep, then sends the set rest', async () => {
    // The crew clock counts no reps, so the set's own pacing carries it: no
    // auto-advance while reps are left, the set rest and auto-advance once the
    // last one is logged. The advance rule stays one the server knows.
    const setOnTheWall = (logged: number) => ({
      sessionId: SESSION,
      stageId: 'four',
      kind: 'fourByFour' as const,
      queueItemUuid: 'item-1',
      mode: 'afterTick' as const,
      targetSeconds: logged >= 2 ? 180 : null,
      advanceOn: 'tick' as const,
      closesSet: logged >= 2,
      reps: { logged, perSet: 2 },
      stagePacing: {
        mode: 'afterTick' as const,
        restSeconds: 0,
        advanceOn: 'set' as const,
        sets: { repsPerSet: 2, restBetweenSetsSeconds: 180 },
      },
    });
    const midSet: OwnRestPacing = {
      mode: 'afterTick',
      targetSeconds: null,
      autoAdvance: false,
      advanceOn: 'tick',
      source: 'stage',
    };
    const setDone: OwnRestPacing = { ...midSet, targetSeconds: 180, autoAdvance: true, autoAdvanceOnce: true };

    own = midSet;
    applyRestTimerStagePacing(setOnTheWall(0), currentNowMs, 'waitForTick');
    vi.advanceTimersByTime(CREW_CONFIGURE_DEBOUNCE_MS);
    await flush();
    expect(sent).toEqual([{ action: 'CONFIGURE', config: toCrewConfigInput(midSet), anchor: 'CLEAR' }]);
    sent.length = 0;

    // The first rep: its TICK, and nothing new for the clock's config.
    noteRestTimerTick(new Date(currentNowMs).toISOString(), 'afterTick', currentNowMs, {
      status: 'attempt',
      queueItemUuid: 'item-1',
    });
    applyRestTimerStagePacing(setOnTheWall(1), currentNowMs, 'none');
    vi.advanceTimersByTime(CREW_CONFIGURE_DEBOUNCE_MS);
    await flush();
    expect(sent.map((input) => input.action)).toEqual(['TICK']);
    sent.length = 0;

    // The last rep: its TICK, then the set rest with auto-advance on, keeping the anchor the TICK set.
    own = setDone;
    noteRestTimerTick(new Date(currentNowMs).toISOString(), 'afterTick', currentNowMs, {
      status: 'send',
      queueItemUuid: 'item-1',
    });
    applyRestTimerStagePacing(setOnTheWall(2), currentNowMs, 'none');
    vi.advanceTimersByTime(CREW_CONFIGURE_DEBOUNCE_MS);
    await flush();
    expect(sent.map((input) => input.action)).toEqual(['TICK', 'CONFIGURE']);
    expect(sent[1]).toEqual({ action: 'CONFIGURE', config: toCrewConfigInput(setDone), anchor: 'KEEP' });
    // Once-only: the server moves the wall at the end of the set rest, then waits.
    expect(sent[1].config).toMatchObject({ autoAdvance: true, autoAdvanceOnce: true });
    sent.length = 0;

    // The next set on the wall: no advance, and no once-only flag left over.
    own = midSet;
    applyRestTimerStagePacing({ ...setOnTheWall(0), queueItemUuid: 'item-2' }, currentNowMs, 'waitForTick');
    vi.advanceTimersByTime(CREW_CONFIGURE_DEBOUNCE_MS);
    await flush();
    expect(sent).toEqual([{ action: 'CONFIGURE', config: toCrewConfigInput(midSet), anchor: 'CLEAR' }]);
    expect(sent[0].config).not.toHaveProperty('autoAdvanceOnce');
  });

  it('never sends a once-only advance for a block after a 4x4: the limit block’s CONFIGURE clears it', async () => {
    own = {
      mode: 'afterTick',
      targetSeconds: 180,
      autoAdvance: true,
      autoAdvanceOnce: true,
      advanceOn: 'tick',
      source: 'stage',
    };
    // The last set's last rep: its set rest goes out once-only.
    applyRestTimerStagePacing(
      {
        sessionId: SESSION,
        stageId: 'four',
        kind: 'fourByFour',
        queueItemUuid: 'item-4',
        mode: 'afterTick',
        targetSeconds: 180,
        advanceOn: 'tick',
        closesSet: true,
        reps: { logged: 2, perSet: 2 },
        stagePacing: {
          mode: 'afterTick',
          restSeconds: 0,
          advanceOn: 'set',
          sets: { repsPerSet: 2, restBetweenSetsSeconds: 180 },
        },
      },
      currentNowMs,
      'none',
    );
    vi.advanceTimersByTime(CREW_CONFIGURE_DEBOUNCE_MS);
    await flush();
    expect(sent).toEqual([{ action: 'CONFIGURE', config: toCrewConfigInput(own), anchor: 'KEEP' }]);
    sent.length = 0;

    own = { mode: 'afterTick', targetSeconds: 180, autoAdvance: true, advanceOn: 'send', source: 'stage' };
    applyRestTimerStagePacing(
      {
        sessionId: SESSION,
        stageId: 'limit',
        kind: 'limitBouldering',
        queueItemUuid: 'item-9',
        mode: 'afterTick',
        targetSeconds: 180,
        advanceOn: 'send',
        closesSet: false,
        stagePacing: { mode: 'afterTick', restSeconds: 180, advanceOn: 'send' },
      },
      currentNowMs,
      'waitForTick',
    );
    vi.advanceTimersByTime(CREW_CONFIGURE_DEBOUNCE_MS);
    await flush();
    expect(sent).toEqual([
      {
        action: 'CONFIGURE',
        config: { mode: 'afterTick', targetSeconds: 180, autoAdvance: true, advanceOn: 'send', source: 'stage' },
        anchor: 'CLEAR',
      },
    ]);
  });

  it('drops a pending CONFIGURE when the timer is turned off', async () => {
    own = { ...own, targetSeconds: 120 };
    publisher.noteSettingsEdited();
    disarmRestTimer();
    vi.advanceTimersByTime(CREW_CONFIGURE_DEBOUNCE_MS);
    await flush();
    expect(sent.map((input) => input.action)).toEqual(['DISARM']);
  });
});

describe('the subscribe seed', () => {
  const seed = (hasClock: boolean) =>
    handleCrewCadenceChange(
      {
        restCadence: hasClock
          ? {
              mode: 'afterTick',
              targetSeconds: 60,
              autoAdvance: true,
              advanceOn: 'deadline',
              source: 'settings',
              isRunning: true,
              anchorAt: String(T0),
              pausedElapsedSeconds: 0,
              setByParticipantId: 'participant-sam',
            }
          : null,
        revision: hasClock ? 5 : 0,
        serverNow: String(currentNowMs),
        isSnapshot: true,
        action: null,
      },
      { sessionId: SESSION, ownParticipantId: ME, receivedAtMs: currentNowMs },
    );

  it('arms the server for a timer this phone armed before the session existed', async () => {
    armRestTimer('onTheMinute', currentNowMs, null);
    bindRestTimerToSession(SESSION);
    await flush();
    expect(sent).toEqual([]);
    currentNowMs += 2_000;
    seed(false);
    publisher.handleSnapshot({ sessionId: SESSION, hasClock: false });
    await flush();
    expect(sent).toEqual([{ action: 'ARM', config: toCrewConfigInput(own), elapsedMs: 2_000 }]);
  });

  it('arms once the arm is bound when the seed came first', async () => {
    seed(false);
    armRestTimer('afterTick', currentNowMs, null);
    bindRestTimerToSession(SESSION);
    await flush();
    expect(sent).toEqual([{ action: 'ARM', config: toCrewConfigInput(own) }]);
  });

  it('carries a pause across', async () => {
    armRestTimer('onTheMinute', currentNowMs, SESSION);
    await flush();
    pauseRestTimer(T0 + 30_000);
    await flush();
    sent.length = 0;
    seed(false);
    publisher.handleSnapshot({ sessionId: SESSION, hasClock: false });
    await flush();
    expect(sent.map((input) => input.action)).toEqual(['ARM', 'PAUSE']);
  });

  it('follows the server’s clock instead when it has one', async () => {
    armRestTimer('afterTick', currentNowMs, SESSION);
    await flush();
    sent.length = 0;
    seed(true);
    publisher.handleSnapshot({ sessionId: SESSION, hasClock: true });
    await flush();
    expect(sent).toEqual([]);
    expect(getRestTimerState().crew?.revision).toBe(5);
  });
});

describe('replies', () => {
  it('are taken like any other change', async () => {
    autoReply = false;
    armRestTimer('afterTick', currentNowMs, SESSION);
    await flush();
    pendingReplies.shift()?.resolve({
      applied: true,
      change: {
        restCadence: {
          mode: 'afterTick',
          targetSeconds: 90,
          autoAdvance: true,
          advanceOn: 'deadline',
          source: 'settings',
          isRunning: true,
          anchorAt: null,
          pausedElapsedSeconds: 0,
          setByParticipantId: ME,
        },
        revision: 7,
        serverNow: String(currentNowMs),
        isSnapshot: false,
        action: 'ARM',
      },
    });
    await flush();
    expect(getRestTimerState().crew?.revision).toBe(7);
  });

  it('stop once the publisher is gone', async () => {
    autoReply = false;
    armRestTimer('afterTick', currentNowMs, SESSION);
    await flush();
    publisher.dispose();
    pendingReplies.shift()?.resolve(reply());
    pauseRestTimer(T0 + 1_000);
    await flush();
    expect(sent.map((input) => input.action)).toEqual(['ARM']);
  });
});

describe('a crew clock this app cannot run', () => {
  it('takes no settings edit to the crew, so this phone never replaces a clock it cannot follow', async () => {
    armRestTimer('afterTick', currentNowMs, SESSION);
    await flush();
    adoptCrewCadence({
      sessionId: SESSION,
      revision: 3,
      config: null,
      isRunning: true,
      anchorMs: T0,
      pausedElapsedSeconds: 0,
      lastFiredBeatMs: null,
      lastTick: null,
      anchorServerMs: T0,
      lastFiredBeatServerMs: null,
    });
    sent.length = 0;
    own = { ...own, targetSeconds: 150 };
    publisher.noteSettingsEdited();
    vi.advanceTimersByTime(CREW_CONFIGURE_DEBOUNCE_MS);
    await flush();
    expect(sent).toEqual([]);
  });
});

describe('crew pacing edits from the timer’s controls', () => {
  function followSamsClock(config: Partial<NonNullable<CrewRestCadence['config']>> = {}) {
    adoptCrewCadence({
      sessionId: SESSION,
      revision: 3,
      config: {
        mode: 'onTheMinute',
        targetSeconds: 120,
        autoAdvance: true,
        advanceOn: 'deadline',
        source: 'settings',
        setByParticipantId: 'participant-sam',
        ...config,
      },
      isRunning: true,
      anchorMs: T0,
      pausedElapsedSeconds: 0,
      lastFiredBeatMs: null,
      lastTick: null,
      anchorServerMs: T0,
      lastFiredBeatServerMs: null,
    });
  }

  it('sends a new rest length on the minute with the crew’s beat kept', async () => {
    followSamsClock();
    editCrewRestPacing({ targetSeconds: 90 });
    await flush();
    expect(sent).toEqual([
      {
        action: 'CONFIGURE',
        config: {
          mode: 'onTheMinute',
          targetSeconds: 90,
          autoAdvance: true,
          advanceOn: 'deadline',
          source: 'settings',
        },
        anchor: 'KEEP',
      },
    ]);
  });

  it('starts the beat now on a switch to on the minute, and waits for a tick on a switch back', async () => {
    followSamsClock({ mode: 'afterTick', advanceOn: 'tick' });
    editCrewRestPacing({ mode: 'onTheMinute' });
    await flush();
    expect(sent.at(-1)).toMatchObject({ action: 'CONFIGURE', anchor: 'NOW', elapsedMs: 0 });
    expect(sent.at(-1)?.config).toMatchObject({ mode: 'onTheMinute', advanceOn: 'tick' });

    followSamsClock();
    editCrewRestPacing({ mode: 'afterTick' });
    await flush();
    expect(sent.at(-1)).toMatchObject({ action: 'CONFIGURE', anchor: 'CLEAR' });
    expect(sent.at(-1)).not.toHaveProperty('elapsedMs');
  });

  it('sends taps that queue up behind one send as one, and keeps the newer draft until it lands', async () => {
    followSamsClock();
    autoReply = false;
    editCrewRestPacing({ targetSeconds: 150 });
    await flush();
    editCrewRestPacing({ targetSeconds: 180 });
    editCrewRestPacing({ targetSeconds: 210 });
    await flush();
    expect(sent.map((input) => input.config?.targetSeconds)).toEqual([150]);

    const replyWithLength = (targetSeconds: number): SetSessionRestCadencePayload => {
      revision += 1;
      return {
        applied: true,
        change: {
          restCadence: {
            mode: 'onTheMinute',
            targetSeconds,
            autoAdvance: true,
            advanceOn: 'deadline',
            source: 'settings',
            isRunning: true,
            anchorAt: String(T0),
            pausedElapsedSeconds: 0,
            setByParticipantId: ME,
          },
          revision,
          serverNow: String(currentNowMs),
          isSnapshot: false,
          action: 'CONFIGURE',
        },
      };
    };
    pendingReplies.shift()?.resolve(replyWithLength(150));
    await flush();
    // The first answer does not take the draft the climber has moved on from.
    expect(getRestTimerState().crewPacingDraft?.targetSeconds).toBe(210);
    expect(getRestTimerState().crew?.config?.targetSeconds).toBe(150);
    expect(sent.map((input) => input.config?.targetSeconds)).toEqual([150, 210]);

    pendingReplies.shift()?.resolve(replyWithLength(210));
    await flush();
    expect(getRestTimerState().crewPacingDraft).toBeNull();
    expect(getRestTimerState().crew?.config?.targetSeconds).toBe(210);
    expect(sent).toHaveLength(2);
  });

  it('lets the draft go when the send fails, so the controls show the crew’s clock again', async () => {
    followSamsClock();
    autoReply = false;
    editCrewRestPacing({ autoAdvance: false });
    await flush();
    pendingReplies.shift()?.reject(new Error('socket closed'));
    await flush();
    expect(report).toHaveBeenCalledTimes(1);
    expect(getRestTimerState().crewPacingDraft).toBeNull();
  });

  it('changes nothing without a crew clock this phone follows', async () => {
    armRestTimer('afterTick', currentNowMs, SESSION);
    await flush();
    sent.length = 0;
    expect(editCrewRestPacing({ targetSeconds: 90 })).toBe(false);
    await flush();
    expect(sent).toEqual([]);
    expect(getRestTimerState().crewPacingDraft).toBeNull();
  });

  it('drops the draft with the publisher, since nothing will send it', () => {
    followSamsClock();
    autoReply = false;
    editCrewRestPacing({ targetSeconds: 90 });
    publisher.dispose();
    expect(getRestTimerState().crewPacingDraft).toBeNull();
  });
});

// The CONFIGUREs this phone sends from the crew clock it holds, on a 4x4 set
// rest (#5382, #5380): a restart re-sends the once-only advance, a move this
// phone made itself spends it, as the server's FIRE does.
describe('a crew clock’s once-only advance', () => {
  const setRestConfig = {
    mode: 'afterTick' as const,
    targetSeconds: 180,
    autoAdvance: true,
    autoAdvanceOnce: true as const,
    advanceOn: 'tick' as const,
    source: 'stage' as const,
    setByParticipantId: 'participant-sam',
  };

  function followCrewClock(config: CrewRestCadence['config']) {
    adoptCrewCadence({
      sessionId: SESSION,
      revision: 3,
      config,
      isRunning: true,
      anchorMs: T0,
      pausedElapsedSeconds: 0,
      lastFiredBeatMs: null,
      lastTick: { status: 'send', queueItemUuid: 'item-wall' },
      anchorServerMs: T0,
      lastFiredBeatServerMs: null,
    });
  }

  beforeEach(async () => {
    armRestTimer('afterTick', currentNowMs, SESSION);
    await flush();
    sent.length = 0;
  });

  it('keeps it in the restart of a set rest that ran out in the background', async () => {
    followCrewClock(setRestConfig);
    currentNowMs = T0 + 200_000;
    reanchorRestTimerAfterBackground(currentNowMs, T0 + 180_000);
    await flush();
    expect(sent).toEqual([
      {
        action: 'CONFIGURE',
        config: {
          mode: 'afterTick',
          targetSeconds: 180,
          autoAdvance: true,
          autoAdvanceOnce: true,
          advanceOn: 'tick',
          source: 'stage',
        },
        anchor: 'NOW',
        elapsedMs: 0,
      },
    ]);
  });

  it('keeps it when a refilled queue picks the set rest back up: that beat moved nothing', async () => {
    followCrewClock(setRestConfig);
    noteRestTimerQueueEnded();
    clearRestTimerQueueEnded(T0 + 5_000, 'afterTick', 'clear');
    await flush();
    expect(sent).toEqual([
      { action: 'CONFIGURE', config: expect.objectContaining({ autoAdvanceOnce: true }), anchor: 'CLEAR' },
    ]);
  });

  it('spends it when this phone moved the wall itself, so the server stops advancing too', async () => {
    followCrewClock(setRestConfig);
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'afterTick', T0 + 180_000, T0 + 180_000, 'clear');
    await flush();
    expect(sent).toEqual([
      {
        action: 'CONFIGURE',
        config: { mode: 'afterTick', targetSeconds: 180, autoAdvance: false, advanceOn: 'tick', source: 'stage' },
        anchor: 'CLEAR',
      },
    ]);
  });

  it.each([
    { mode: 'afterTick' as const, anchorAfter: 'clear' as const, advanceOn: 'tick' as const },
    { mode: 'onTheMinute' as const, anchorAfter: 'keep' as const, advanceOn: 'tick' as const },
    { mode: 'afterTick' as const, anchorAfter: 'now' as const, advanceOn: 'deadline' as const },
  ])(
    'keeps a local $anchorAfter advance spent when its CONFIGURE fails offline',
    async ({ mode, anchorAfter, advanceOn }) => {
      followCrewClock({ ...setRestConfig, mode, advanceOn });
      autoReply = false;
      currentNowMs = T0 + 180_000;
      noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, mode, currentNowMs, currentNowMs, anchorAfter);

      // The server has not answered: scheduling must already see the move as spent.
      expect(sent.at(-1)).toMatchObject({ action: 'CONFIGURE', config: { autoAdvance: false } });
      expect(getRestTimerState().crew?.config?.autoAdvance).toBe(false);
      expect(getRestTimerState().crew?.config).not.toHaveProperty('autoAdvanceOnce');

      const offlineError = new Error('offline');
      pendingReplies.shift()?.reject(offlineError);
      await flush();
      expect(report).toHaveBeenCalledWith(offlineError, 'CONFIGURE');

      currentNowMs += 1_000;
      noteRestTimerTick(new Date(currentNowMs).toISOString(), mode, currentNowMs, {
        status: 'send',
        queueItemUuid: 'item-next',
      });
      const state = getRestTimerState();
      expect(state.stagePacing).toBeNull();
      expect(
        resolveEffectiveRestPacing({ settings: own, stage: state.stagePacing, crew: state.crew?.config ?? null }),
      ).toMatchObject({
        source: 'crew',
        autoAdvance: false,
      });
      expect(state.crew?.config).not.toHaveProperty('autoAdvanceOnce');
    },
  );

  it('keeps an ordinary clock enabled when local move synchronization fails offline', async () => {
    const { autoAdvanceOnce: _once, ...everyRest } = setRestConfig;
    followCrewClock(everyRest);
    autoReply = false;
    currentNowMs = T0 + 180_000;
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'afterTick', currentNowMs, currentNowMs, 'clear');
    expect(getRestTimerState().crew?.config?.autoAdvance).toBe(true);
    pendingReplies.shift()?.reject(new Error('offline'));
    await flush();

    currentNowMs += 1_000;
    noteRestTimerTick(new Date(currentNowMs).toISOString(), 'afterTick', currentNowMs, {
      status: 'send',
      queueItemUuid: 'item-next',
    });
    const state = getRestTimerState();
    expect(
      resolveEffectiveRestPacing({ settings: own, stage: state.stagePacing, crew: state.crew?.config ?? null })
        .autoAdvance,
    ).toBe(true);
  });

  it('spends it after a cadence edit when a solo fallback keeps the minute beat', async () => {
    followCrewClock(setRestConfig);
    autoReply = false;
    expect(editCrewRestPacing({ mode: 'onTheMinute' })).toBe(true);
    await flush();
    expect(sent.at(-1)).toMatchObject({
      action: 'CONFIGURE',
      config: { mode: 'onTheMinute', autoAdvanceOnce: true },
      anchor: 'NOW',
    });
    pendingReplies.shift()?.resolve({
      applied: true,
      change: {
        restCadence: {
          ...setRestConfig,
          mode: 'onTheMinute',
          source: 'settings',
          isRunning: true,
          anchorAt: String(T0),
          pausedElapsedSeconds: 0,
          lastTickQueueItemUuid: 'item-wall',
          lastTickStatus: 'send',
        },
        revision: ++revision,
        serverNow: String(currentNowMs),
        isSnapshot: false,
        action: 'CONFIGURE',
      },
    });
    await flush();
    sent.length = 0;

    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'onTheMinute', T0 + 180_000, T0 + 180_000, 'keep');
    await flush();
    expect(sent).toEqual([
      {
        action: 'CONFIGURE',
        config: { mode: 'onTheMinute', targetSeconds: 180, autoAdvance: false, advanceOn: 'tick', source: 'settings' },
        anchor: 'KEEP',
      },
    ]);
  });

  it('spends it when a local move starts another deadline rest', async () => {
    followCrewClock({ ...setRestConfig, advanceOn: 'deadline' });
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'afterTick', T0 + 180_000, T0 + 180_000, 'now');
    await flush();
    expect(sent).toEqual([
      {
        action: 'CONFIGURE',
        config: { mode: 'afterTick', targetSeconds: 180, autoAdvance: false, advanceOn: 'deadline', source: 'stage' },
        anchor: 'NOW',
        elapsedMs: 0,
      },
    ]);
  });

  it('keeps it when a refilled queue resumes the minute beat without moving the wall', async () => {
    followCrewClock({ ...setRestConfig, mode: 'onTheMinute' });
    noteRestTimerQueueEnded();
    clearRestTimerQueueEnded(T0 + 5_000, 'onTheMinute', 'keep');
    await flush();
    expect(sent).toEqual([]);
    expect(getRestTimerState().crew?.config?.autoAdvanceOnce).toBe(true);
  });

  it('keeps auto-advance on after a local move on a clock that advances every rest', async () => {
    const { autoAdvanceOnce: _once, ...everyRest } = setRestConfig;
    followCrewClock(everyRest);
    noteRestTimerAutoAdvanceFired(getRestTimerState().cycleId, 'afterTick', T0 + 180_000, T0 + 180_000, 'clear');
    await flush();
    expect(sent).toEqual([
      {
        action: 'CONFIGURE',
        config: { mode: 'afterTick', targetSeconds: 180, autoAdvance: true, advanceOn: 'tick', source: 'stage' },
        anchor: 'CLEAR',
      },
    ]);
  });

  it('keeps it through a crew rest-length edit from the timer’s controls', async () => {
    followCrewClock(setRestConfig);
    editCrewRestPacing({ targetSeconds: 240 });
    await flush();
    expect(sent).toEqual([
      {
        action: 'CONFIGURE',
        config: {
          mode: 'afterTick',
          targetSeconds: 240,
          autoAdvance: true,
          autoAdvanceOnce: true,
          advanceOn: 'tick',
          source: 'settings',
        },
        anchor: 'KEEP',
      },
    ]);
  });

  it('never turns a spent advance back on with a rest-length edit that goes out after the FIRE', async () => {
    followCrewClock(setRestConfig);
    autoReply = false;
    editCrewRestPacing({ targetSeconds: 240 });
    await flush();
    // A second tap waits behind the first send.
    editCrewRestPacing({ targetSeconds: 270 });
    await flush();
    // The server still held the flag when the first one went out.
    expect(sent).toEqual([
      {
        action: 'CONFIGURE',
        config: expect.objectContaining({ targetSeconds: 240, autoAdvanceOnce: true }),
        anchor: 'KEEP',
      },
    ]);

    const crewChange = (
      changeRevision: number,
      clock: Pick<SessionRestCadence, 'autoAdvance' | 'autoAdvanceOnce' | 'anchorAt' | 'lastFiredBeatAt'>,
    ): SetSessionRestCadencePayload['change'] => ({
      restCadence: {
        mode: 'afterTick',
        targetSeconds: 240,
        advanceOn: 'tick',
        source: 'settings',
        isRunning: true,
        pausedElapsedSeconds: 0,
        lastTickQueueItemUuid: 'item-wall',
        lastTickStatus: 'send',
        setByParticipantId: ME,
        ...clock,
      },
      revision: changeRevision,
      serverNow: String(currentNowMs),
      isSnapshot: false,
      action: null,
    });
    // The server took that CONFIGURE, then the holder's FIRE moved the wall and
    // spent the flag. Its event reaches this phone before the CONFIGURE's reply.
    currentNowMs = T0 + 240_000;
    handleCrewCadenceChange(
      crewChange(revision + 2, {
        autoAdvance: false,
        autoAdvanceOnce: false,
        anchorAt: null,
        lastFiredBeatAt: String(T0 + 240_000),
      }),
      { sessionId: SESSION, ownParticipantId: ME, receivedAtMs: currentNowMs },
    );
    expect(getRestTimerState().crew?.config).toMatchObject({ autoAdvance: false, targetSeconds: 240 });
    pendingReplies.shift()?.resolve({
      applied: true,
      change: crewChange(revision + 1, {
        autoAdvance: true,
        autoAdvanceOnce: true,
        anchorAt: String(T0),
        lastFiredBeatAt: null,
      }),
    });
    await flush();

    // The second tap keeps its length and leaves the set rest's move spent.
    expect(sent[1]).toEqual({
      action: 'CONFIGURE',
      config: { mode: 'afterTick', targetSeconds: 270, autoAdvance: false, advanceOn: 'tick', source: 'settings' },
      anchor: 'KEEP',
    });
    pendingReplies.shift()?.resolve(null);
    await flush();
    expect(getRestTimerState().crewPacingDraft).toBeNull();
  });
});
