// Sends this phone's rest-timer actions to the session's shared clock (#5382).
// The logic behind RestTimerCrewPublisher, free of React so the order, the
// debounce and the seed rules are tested on their own.
//
// What goes out (workouts contracts §10):
//   arm / disarm              ARM with this phone's own pacing / DISARM
//   tick                      TICK with the queue item and how it went
//   pause / resume / reset    PAUSE / RESUME / RESET
//   rest restarted            RESET on the deadline, else CONFIGURE anchor NOW
//   queue refilled, or the    RESET, CONFIGURE anchor CLEAR, or nothing
//   wall moved by this phone
//   settings edit, stage      CONFIGURE with this phone's own pacing, 400 ms
//   change on the wall        debounced, anchor NOW / CLEAR at a stage boundary
// and, on the subscribe seed, an ARM for a timer this phone runs that the
// server does not have (it was armed before the session, or the server lost it).
//
// Sends go one at a time, in order. Each reply is the server's clock and is
// taken like any other change (handleCrewCadenceChange), so the floor and the
// adoption rule apply to it too. A failed send is reported and dropped: the
// next change, or the next seed, brings the phone back in step.

import type { SessionRestCadenceInput, SetSessionRestCadencePayload } from '@boardsesh/shared-schema/generated';
import {
  buildArmInput,
  buildConfigureInput,
  buildRestartInput,
  buildTickInput,
  getLastCrewCadenceSnapshot,
  handleCrewCadenceChange,
  normalizeCrewConfig,
  toCrewConfigInput,
  type CrewAnchorRequest,
  type CrewCadenceSnapshot,
  type CrewConfigFields,
  type OwnRestPacing,
} from './crew-rest-cadence';
import type { LocalRestTimerAction, RestTimerState } from './rest-timer-store';

/** Settings edits and stage changes inside this window go out as one CONFIGURE. */
export const CREW_CONFIGURE_DEBOUNCE_MS = 400;

export type CrewRestPublisherDeps = {
  sessionId: string;
  send: (input: SessionRestCadenceInput) => Promise<SetSessionRestCadencePayload | null>;
  getOwnParticipantId: () => string | null;
  getState: () => RestTimerState;
  getOwnPacing: () => OwnRestPacing;
  nowMs: () => number;
  report: (error: unknown, action: SessionRestCadenceInput['action']) => void;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
};

export type CrewRestPublisher = {
  handleLocalAction: (action: LocalRestTimerAction) => void;
  /** The climber changed one of their three rest settings. */
  noteSettingsEdited: () => void;
  handleSnapshot: (snapshot: CrewCadenceSnapshot) => void;
  dispose: () => void;
};

type PendingConfigure = { anchor: CrewAnchorRequest; elapsedFromLocalAnchor: boolean };

type QueuedSend = { input: SessionRestCadenceInput; config: CrewConfigFields | null };

export function createCrewRestPublisher({
  sessionId,
  send,
  getOwnParticipantId,
  getState,
  getOwnPacing,
  nowMs,
  report,
  setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer = (handle) => clearTimeout(handle),
}: CrewRestPublisherDeps): CrewRestPublisher {
  let disposed = false;
  let sending = false;
  // Each entry builds its input when it goes out, so an elapsed it carries is
  // measured at send time even after waiting behind another send. An ARM or
  // CONFIGURE also names the config it sends.
  const queue: Array<() => QueuedSend | null> = [];
  let pendingConfigure: PendingConfigure | null = null;
  let configureTimer: ReturnType<typeof setTimeout> | null = null;
  // The config this phone last sent, for comparing a CONFIGURE against while
  // the server's answer (and so the crew clock) has not come back yet.
  let lastPublishedConfig: CrewConfigFields | null = null;

  const armedHere = (): boolean => {
    const state = getState();
    return state.armed && state.armedForSessionId === sessionId;
  };

  async function pump(): Promise<void> {
    if (sending || disposed) return;
    const build = queue.shift();
    if (!build) return;
    const queued = build();
    if (queued === null) {
      void pump();
      return;
    }
    const { input, config } = queued;
    sending = true;
    const sentAtMs = nowMs();
    try {
      const payload = await send(input);
      if (payload && !disposed) {
        if (config !== null && payload.applied) lastPublishedConfig = config;
        handleCrewCadenceChange(payload.change, {
          sessionId,
          ownParticipantId: getOwnParticipantId(),
          receivedAtMs: nowMs(),
          sentAtMs,
        });
      }
    } catch (error) {
      if (!disposed) report(error, input.action);
    } finally {
      sending = false;
    }
    void pump();
  }

  function enqueue(build: () => QueuedSend | null): void {
    if (disposed) return;
    queue.push(build);
    void pump();
  }

  /** An action with no config of its own. */
  function enqueueInput(build: () => SessionRestCadenceInput | null): void {
    enqueue(() => {
      const input = build();
      return input === null ? null : { input, config: null };
    });
  }

  function cancelPendingConfigure(): void {
    if (configureTimer !== null) clearTimer(configureTimer);
    configureTimer = null;
    pendingConfigure = null;
  }

  function flushConfigure(): void {
    configureTimer = null;
    const request = pendingConfigure;
    pendingConfigure = null;
    if (request === null) return;
    enqueue(() => {
      if (!armedHere()) return null;
      const state = getState();
      const own = getOwnPacing();
      const input = buildConfigureInput({
        own,
        previous: state.crew?.config ?? lastPublishedConfig,
        anchor: request.anchor,
        elapsedFromLocalAnchor: request.elapsedFromLocalAnchor,
        state,
        nowMs: nowMs(),
      });
      return input === null ? null : { input, config: normalizeCrewConfig(own) };
    });
  }

  function requestConfigure(request: PendingConfigure): void {
    if (disposed) return;
    // A boundary's anchor outlives a plain edit that lands in the same window.
    pendingConfigure =
      request.anchor !== 'KEEP' || pendingConfigure === null || pendingConfigure.anchor === 'KEEP'
        ? request
        : pendingConfigure;
    if (configureTimer !== null) clearTimer(configureTimer);
    configureTimer = setTimer(flushConfigure, CREW_CONFIGURE_DEBOUNCE_MS);
  }

  function enqueueArm(): void {
    enqueue(() => {
      if (!armedHere()) return null;
      const own = getOwnPacing();
      return { input: buildArmInput(own, getState(), nowMs()), config: normalizeCrewConfig(own) };
    });
    // ARM always starts the clock running; a paused timer follows with its pause.
    enqueueInput(() => {
      const state = getState();
      if (!armedHere() || state.isRunning) return null;
      return { action: 'PAUSE', pausedElapsedSeconds: state.pausedElapsedSeconds };
    });
  }

  /** A timer this phone runs that the server has no clock for. */
  function armIfServerHasNoClock(): void {
    const snapshot = getLastCrewCadenceSnapshot();
    if (snapshot?.sessionId !== sessionId || snapshot.hasClock) return;
    if (!armedHere() || getState().crew !== null) return;
    enqueueArm();
  }

  function heldConfig(): CrewConfigFields {
    return getState().crew?.config ?? getOwnPacing();
  }

  return {
    handleLocalAction(action) {
      if (disposed || action.sessionId !== sessionId) return;
      switch (action.type) {
        case 'arm':
          cancelPendingConfigure();
          enqueueArm();
          return;
        case 'bound':
          armIfServerHasNoClock();
          return;
        case 'disarm':
          cancelPendingConfigure();
          enqueueInput(() => ({ action: 'DISARM' }));
          return;
        case 'tick': {
          const { tick, tickStartMs, tickRecorded } = action;
          if (tick === null) return;
          // A late tick on another climb, kept out of the last tick here under a
          // tick or send rule, must not take the wall climb's place on the server
          // either (the server keeps whichever TICK came last).
          const crewRule = getState().crew?.config?.advanceOn ?? 'deadline';
          if (crewRule !== 'deadline' && !tickRecorded) return;
          enqueueInput(() => buildTickInput(tick, tickStartMs, nowMs()));
          return;
        }
        case 'pause':
          enqueueInput(() => ({ action: 'PAUSE', pausedElapsedSeconds: action.pausedElapsedSeconds }));
          return;
        case 'resume':
          enqueueInput(() => ({ action: 'RESUME' }));
          return;
        case 'reset':
          enqueueInput(() => ({ action: 'RESET', isRunning: action.isRunning }));
          return;
        case 'reanchored':
          enqueueInput(() => buildRestartInput(heldConfig(), getState(), nowMs()));
          return;
        // A wall this phone moved itself, or a refilled queue: the shared rest
        // restarts (RESET), waits for a tick (CLEAR), or keeps its beat.
        case 'fired':
        case 'queueEndedCleared':
          if (action.anchorAfter === 'keep') return;
          enqueueInput(() =>
            action.anchorAfter === 'now'
              ? { action: 'RESET', isRunning: true }
              : { action: 'CONFIGURE', config: toCrewConfigInput(heldConfig()), anchor: 'CLEAR' },
          );
          return;
        case 'stagePacing':
          requestConfigure({
            anchor: action.transition === 'anchorNow' ? 'NOW' : action.transition === 'waitForTick' ? 'CLEAR' : 'KEEP',
            elapsedFromLocalAnchor: action.transition === 'anchorNow',
          });
          return;
        default: {
          const unhandled: never = action;
          throw new Error(`Unhandled rest timer action: ${JSON.stringify(unhandled)}`);
        }
      }
    },
    noteSettingsEdited() {
      if (!armedHere()) return;
      requestConfigure({ anchor: 'KEEP', elapsedFromLocalAnchor: false });
    },
    handleSnapshot(snapshot) {
      if (disposed || snapshot.sessionId !== sessionId) return;
      armIfServerHasNoClock();
    },
    dispose() {
      disposed = true;
      cancelPendingConfigure();
      queue.length = 0;
    },
  };
}
