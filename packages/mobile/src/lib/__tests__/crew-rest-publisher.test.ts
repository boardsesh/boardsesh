// What this phone sends to the crew's shared clock, and when (#5382).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRestCadenceInput, SetSessionRestCadencePayload } from '@boardsesh/shared-schema/generated';
import {
  handleCrewCadenceChange,
  resetCrewCadenceForTests,
  toCrewConfigInput,
  type OwnRestPacing,
} from '../crew-rest-cadence';
import { CREW_CONFIGURE_DEBOUNCE_MS, createCrewRestPublisher, type CrewRestPublisher } from '../crew-rest-publisher';
import {
  adoptCrewCadence,
  applyRestTimerStagePacing,
  armRestTimer,
  bindRestTimerToSession,
  disarmRestTimer,
  getRestTimerState,
  noteRestTimerAutoAdvanceFired,
  noteRestTimerTick,
  pauseRestTimer,
  reanchorRestTimerAfterBackground,
  resetRestTimer,
  resetRestTimerStoreForTests,
  resumeRestTimer,
  subscribeLocalRestTimerActions,
} from '../rest-timer-store';
import { resetServerClock } from '../server-clock';

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
});

describe('ticks', () => {
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
        closesRound: false,
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
        closesRound: false,
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
        targetSeconds: 10,
        advanceOn: 'tick',
        closesRound: false,
        stagePacing: { mode: 'afterTick', restSeconds: 0, restBetweenRoundsSeconds: 180, advanceOn: 'tick' },
      },
      currentNowMs,
      'waitForTick',
    );
    publisher.noteSettingsEdited();
    vi.advanceTimersByTime(CREW_CONFIGURE_DEBOUNCE_MS);
    await flush();
    expect(sent).toEqual([{ action: 'CONFIGURE', config: toCrewConfigInput(own), anchor: 'CLEAR' }]);
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
