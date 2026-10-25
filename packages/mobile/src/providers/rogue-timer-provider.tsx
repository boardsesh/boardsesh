// RogueTimerProvider — connects to and drives a Rogue Fitness workout timer
// (Home Timer 2.0 / Echo Gym Timer 2.0) paired to the active board.
//
// Three hard rules shape this provider:
//
//  1. The timer is *gym equipment paired to a board*. Which timer to talk to
//     comes from the active board's `timerName` (set in Settings › Timers or the
//     board form), not a global app setting. No pairing → nothing happens.
//
//  2. Only the climber *driving the wall* touches the timer. In a gym several
//     people may have the same board saved with the same paired timer; if each
//     of them drove it they'd stomp on each other. So the timer is only
//     connected while this phone holds the board's Bluetooth link
//     (`canDriveGymTimer` in lib/session-timer/driver-rule.ts — the lightbulb is
//     on). When the board disconnects, we drop the timer too.
//
//  3. The radio has ONE scan slot (react-native-ble-plx). A reconnect scan and a
//     pairing scan must never run at once: whichever starts second replaces the
//     first, and a reconnect stops every scan when it settles. So pairing scans
//     go through `schedulePairingScan`, which waits for a reconnect in flight,
//     and no reconnect starts while a pairing scan holds the slot.
//
// What the timer shows follows the session timer (#5397): RogueSessionTimerSink
// diffs the rest timer's snapshot and restarts the stopwatch when a new rest
// starts (a climb saved on this phone, an auto-advance, a fixed-window beat, a
// Reset), resets it when the rest timer is switched off, and restarts it on a
// fresh tick while the rest timer is off. See docs/rest-timer.md.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RogueTimerCommand, type RogueTimerCommandCode } from '@boardsesh/ble-protocol/rogue-timer';
import { RogueTimerController } from '../lib/ble/rogue-timer-ble';
import { useActiveBoard } from '../lib/graphql/use-active-board';
import { useSessionTimerDriver } from '../hooks/use-session-timer-driver';
import { useEffectiveRestPacing } from '../hooks/use-effective-rest-pacing';
import { useRestTimerState } from '../hooks/use-rest-timer';
import { nowMs } from '../lib/clock';
import { getRestTimerState } from '../lib/rest-timer-store';
import {
  buildSessionTimerSnapshot,
  getSessionTimerWakeMs,
  isArmedForThisPhone,
  type SessionTimerSnapshot,
} from '../lib/session-timer/snapshot';
import {
  deriveSessionTimerCommands,
  deriveSessionTimerTickCommand,
  type SessionTimerCommand,
} from '../lib/session-timer/commands';
import { createLatestWinsQueue, type LatestWinsQueue } from '../lib/session-timer/command-queue';
import { subscribeSessionTimerTicks } from '../lib/session-timer/tick-events';
import { useQueueSessionId } from './queue-provider';
import {
  RogueTimerContext,
  type RogueTimerContextValue,
  type RogueTimerPairingScanStarter,
  type RogueTimerStatus,
} from './rogue-timer-context';

// Gap between key presses. The timer is a slow HM-10 UART display; back-to-back
// frames can be dropped, so we space the STOPWATCH → RESET → OK sequence out, and
// the first press of a command from the last press of the one before. Tune
// on-device — we can't exercise real hardware in CI.
const KEY_SEQUENCE_GAP_MS = 180;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The key presses for one session-timer command, sent with a gap between each. */
export function rogueKeysForCommand(command: SessionTimerCommand): RogueTimerCommandCode[] {
  // Enter stopwatch mode, zero it, then start counting. Assumes the timer is at
  // its top-level screen (not buried in a setup sub-menu): the STOPWATCH key
  // selects the mode from the home screen, and there is no telemetry back, so a
  // wrong precondition fails silently.
  if (command.kind === 'restartCountUp') {
    return [RogueTimerCommand.STOPWATCH, RogueTimerCommand.RESET, RogueTimerCommand.OK];
  }
  return [RogueTimerCommand.RESET];
}

// A restart whose OK has not gone out yet starts the clock after any later
// restart was asked for. Sending the second one too would press OK twice, and OK
// is a start/stop toggle: two in a row leave the clock stopped.
function restartAbsorbsRestart(inFlight: SessionTimerCommand, incoming: SessionTimerCommand): boolean {
  return inFlight.kind === 'restartCountUp' && incoming.kind === 'restartCountUp';
}

// A fixed window rolls over at its deadline. Wake just after it, so the snapshot
// built then is already in the next window.
const WINDOW_WAKE_SLACK_MS = 25;

// Bounded auto-reconnect: after this many consecutive drop→reconnect cycles the
// provider gives up (status 'error') instead of looping forever, so a timer
// flapping at range-edge can't burn the battery for the whole wall session. A
// board-LED toggle or re-pair resets the counter and tries again.
const MAX_RECONNECT_ATTEMPTS = 4;
// A connection that survives this long is treated as stable, resetting the
// attempt counter — so a single drop much later in a long session still gets a
// fresh set of retries rather than counting against early-session churn.
const STABLE_CONNECTION_MS = 30_000;

export function RogueTimerProvider({ children }: { children: ReactNode }) {
  const { data: activeBoard } = useActiveBoard();
  // Today's answer: this phone holds the board's Bluetooth link. A crew
  // passenger never does, so a passenger's phone never talks to the timer.
  const { canDriveGymTimer } = useSessionTimerDriver();
  // Empty string / null both mean "no timer paired".
  const timerName = activeBoard?.timerName?.trim() || null;

  const controllerRef = useRef<RogueTimerController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new RogueTimerController();
  }
  const controller = controllerRef.current;

  const [status, setStatus] = useState<RogueTimerStatus>('idle');
  const [deviceName, setDeviceName] = useState<string | undefined>(undefined);
  // The timer name we currently hold (or are opening) a connection for, so the
  // reconcile effect doesn't reconnect on unrelated re-renders.
  const connectedTargetRef = useRef<string | null>(null);
  // Bumped to re-run the reconcile effect: when the connected timer drops
  // unexpectedly (a single reconnect attempt while the board LED is still held),
  // and when a pairing scan that held a reconnect back hands the slot back.
  const [reconnectTick, setReconnectTick] = useState(0);
  // Consecutive drop→reconnect cycles, and the "connection is stable" timer that
  // resets them. Bounded by MAX_RECONNECT_ATTEMPTS so a flapping timer stops.
  const reconnectAttemptsRef = useRef(0);
  const stableTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearStableTimer = useCallback(() => {
    if (stableTimerRef.current) {
      clearTimeout(stableTimerRef.current);
      stableTimerRef.current = null;
    }
  }, []);

  // The scan slot, in refs: the reconcile effect and the pairing scheduler read
  // them at the moment they act, and a sheet opening must not re-run the
  // reconcile effect (its cleanup would drop the live connection's listener).
  //   openPairingScansRef  pairing scans holding the slot, waiting or running
  //   connectAttemptRef    the reconnect in flight; it stops every scan when it settles
  //   connectDeferredRef   a reconnect was held back for a pairing scan
  const openPairingScansRef = useRef(0);
  const connectAttemptRef = useRef<Promise<void> | null>(null);
  const connectDeferredRef = useRef(false);

  // Reconcile the timer connection with "driving the wall + a paired timer".
  // Connects when both become true; disconnects when either goes false, the
  // board changes, or the pairing is cleared.
  useEffect(() => {
    const shouldConnect = canDriveGymTimer && timerName !== null;
    let cancelled = false;
    let unsubscribeDisconnect: (() => void) | undefined;

    if (shouldConnect) {
      if (connectedTargetRef.current === timerName) return;
      // A pairing scan holds the slot, and a reconnect scan now would replace
      // it. Wait: the pairing scan's release re-runs this effect.
      if (openPairingScansRef.current > 0) {
        connectDeferredRef.current = true;
        return;
      }
      // An earlier connect is still scanning or connecting on this controller
      // (the paired timer changed under it, or the board LED flapped). Its run
      // was cleaned up, so it is cancelled. A second one now would overlap it:
      // the first one's settle stops every scan, and its cancelled path
      // disconnects whatever link the controller holds by then. Wait for it to
      // settle, then try again. Its target no longer counts as held, or a
      // switch back to that timer would read as already connected.
      const pendingConnect = connectAttemptRef.current;
      if (pendingConnect !== null) {
        connectedTargetRef.current = null;
        setStatus('connecting');
        void pendingConnect.then(() => {
          if (!cancelled) setReconnectTick((tick) => tick + 1);
        });
        return () => {
          cancelled = true;
        };
      }
      connectedTargetRef.current = timerName;
      setStatus('connecting');
      const connectAttempt = controller.connectByName(timerName);
      const attemptSettled = connectAttempt.then(
        () => undefined,
        () => undefined,
      );
      connectAttemptRef.current = attemptSettled;
      void attemptSettled.then(() => {
        if (connectAttemptRef.current === attemptSettled) connectAttemptRef.current = null;
      });
      connectAttempt
        .then((connection) => {
          if (cancelled) {
            void controller.disconnect();
            return;
          }
          setStatus('connected');
          setDeviceName(connection.deviceName ?? timerName);
          // A connection that holds for STABLE_CONNECTION_MS is "good" — reset
          // the flap counter so a much-later single drop still gets fresh retries.
          clearStableTimer();
          stableTimerRef.current = setTimeout(() => {
            reconnectAttemptsRef.current = 0;
          }, STABLE_CONNECTION_MS);
          // Reflect an unsolicited drop (out of range / powered off): the
          // controller clears its own refs, but the provider must clear the
          // target + status too, or the badge stays stuck on "connected" and the
          // reconcile guard blocks any reconnect. Retry via reconnectTick until
          // MAX_RECONNECT_ATTEMPTS consecutive flaps, then give up (status
          // 'error') so a range-edge timer can't loop forever.
          unsubscribeDisconnect = controller.onDisconnect(() => {
            clearStableTimer();
            connectedTargetRef.current = null;
            setDeviceName(undefined);
            reconnectAttemptsRef.current += 1;
            if (reconnectAttemptsRef.current > MAX_RECONNECT_ATTEMPTS) {
              setStatus('error');
            } else {
              setStatus('idle');
              setReconnectTick((tick) => tick + 1);
            }
          });
        })
        .catch(() => {
          if (cancelled) return;
          // Failed to find/connect the timer — clear the target so a later
          // board-reconnect (or a retry when the timer powers on) tries again.
          connectedTargetRef.current = null;
          setStatus('error');
          setDeviceName(undefined);
        });
    } else {
      // Not driving the wall (or no pairing). Drop any live connection, and
      // always settle status back to 'idle' — including from a lingering
      // 'error'/'connecting' from a prior failed attempt — so the badge reflects
      // "not active" rather than a stale error. setStatus('idle') is a no-op
      // when already idle (React bails), so this is cheap on every idle render.
      connectDeferredRef.current = false;
      if (connectedTargetRef.current !== null) {
        connectedTargetRef.current = null;
        void controller.disconnect();
      }
      // Stopped driving the wall — a fresh set of retries when we next connect.
      clearStableTimer();
      reconnectAttemptsRef.current = 0;
      setStatus('idle');
      setDeviceName(undefined);
    }

    return () => {
      cancelled = true;
      unsubscribeDisconnect?.();
    };
  }, [controller, canDriveGymTimer, timerName, reconnectTick, clearStableTimer]);

  // Drop the connection when the provider unmounts (app teardown).
  useEffect(() => {
    return () => {
      clearStableTimer();
      void controller.disconnect();
    };
  }, [controller, clearStableTimer]);

  const releasePairingScanSlot = useCallback(() => {
    openPairingScansRef.current = Math.max(0, openPairingScansRef.current - 1);
    if (openPairingScansRef.current > 0 || !connectDeferredRef.current) return;
    connectDeferredRef.current = false;
    setReconnectTick((tick) => tick + 1);
  }, []);

  const schedulePairingScan = useCallback(
    (startScan: RogueTimerPairingScanStarter) => {
      openPairingScansRef.current += 1;
      let stopped = false;
      let released = false;
      let stopScan: (() => void) | null = null;
      const releaseSlot = () => {
        if (released) return;
        released = true;
        releasePairingScanSlot();
      };
      const begin = () => {
        if (stopped) return;
        // A reconnect stops every scan when it settles, so start only after it.
        // None starts while this scan holds the slot.
        const pendingConnect = connectAttemptRef.current;
        if (pendingConnect !== null) {
          void pendingConnect.then(begin);
          return;
        }
        stopScan = startScan(releaseSlot);
      };
      begin();
      return () => {
        if (stopped) return;
        stopped = true;
        stopScan?.();
        releaseSlot();
      };
    },
    [releasePairingScanSlot],
  );

  const value = useMemo<RogueTimerContextValue>(
    () => ({
      status,
      isConnected: status === 'connected',
      deviceName,
      schedulePairingScan,
    }),
    [status, deviceName, schedulePairingScan],
  );

  return (
    <RogueTimerContext.Provider value={value}>
      {status === 'connected' ? <RogueSessionTimerSink controller={controller} /> : null}
      {children}
    </RogueTimerContext.Provider>
  );
}

/**
 * Drives the connected timer from the session timer. Renders nothing, and is
 * mounted only while a timer is connected, so it costs nothing for climbers who
 * never pair one. It re-renders on rest-timer store writes and pacing changes (a
 * few per rest) and wakes once per fixed window: no per-second work.
 */
function RogueSessionTimerSink({ controller }: { controller: RogueTimerController }) {
  const restTimerState = useRestTimerState();
  const { targetSeconds, mode } = useEffectiveRestPacing();
  const { sessionId } = useQueueSessionId();
  // For the tick bus, which runs outside a render.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // Bumped at a fixed window's end, the one change no store write announces.
  const [windowWakes, setWindowWakes] = useState(0);

  // Created in an effect rather than a memo, so a StrictMode remount gets a live
  // queue instead of the one its first cleanup disposed.
  const queueRef = useRef<LatestWinsQueue<SessionTimerCommand> | null>(null);
  useEffect(() => {
    // When the last press went out. The queue starts the next command the moment
    // the one before resolves, so a reset queued behind a restart would follow
    // its OK with no gap at all.
    let lastPressAtMs: number | null = null;
    const queue = createLatestWinsQueue<SessionTimerCommand>(
      async (command) => {
        for (const key of rogueKeysForCommand(command)) {
          if (lastPressAtMs !== null) {
            const sinceLastPressMs = Math.max(0, nowMs() - lastPressAtMs);
            if (sinceLastPressMs < KEY_SEQUENCE_GAP_MS) await wait(KEY_SEQUENCE_GAP_MS - sinceLastPressMs);
          }
          try {
            // Throws once the link has gone, and the queue swallows it: the
            // timer is a display, not a source of truth.
            await controller.pressButton(key);
          } finally {
            lastPressAtMs = nowMs();
          }
        }
      },
      { absorbs: restartAbsorbsRestart },
    );
    queueRef.current = queue;
    return () => {
      queue.dispose();
      if (queueRef.current === queue) queueRef.current = null;
    };
  }, [controller]);

  // The last snapshot, null until the first: connecting is never a reason to
  // restart the clock on the wall.
  const snapshotRef = useRef<SessionTimerSnapshot | null>(null);
  // The climb the tick bus just delivered with the rest timer on, until a
  // snapshot shows the rest timer storing it, or off. Only that climb restarts
  // the clock through the snapshot: a `lastTickAt` without it (the session's
  // last tick read back on arming or a cold start) was not logged now. Dropping
  // the stamp on 'off' means a re-arm can never mistake that climb, read back
  // later, for one saved now.
  const savedTickAtRef = useRef<string | null>(null);
  useEffect(() => {
    const now = nowMs();
    const next = buildSessionTimerSnapshot({
      state: restTimerState,
      pacing: { targetSeconds, mode },
      sessionId,
      nowMs: now,
    });
    const savedTickAt = savedTickAtRef.current;
    for (const command of deriveSessionTimerCommands(snapshotRef.current, next, now, savedTickAt)) {
      queueRef.current?.push(command);
    }
    if (next.status === 'off' || next.lastTickAt === savedTickAt) savedTickAtRef.current = null;
    snapshotRef.current = next;

    const wakeMs = getSessionTimerWakeMs(next);
    if (wakeMs === null) return undefined;
    const timeout = setTimeout(
      () => setWindowWakes((wakes) => wakes + 1),
      Math.max(0, wakeMs - now) + WINDOW_WAKE_SLACK_MS,
    );
    return () => clearTimeout(timeout);
  }, [restTimerState, targetSeconds, mode, sessionId, windowWakes]);

  // With the rest timer off, a fresh logged climb restarts the clock, as every
  // tick did before the session timer existed. With it on, the climb is stamped
  // for the snapshot, which restarts the clock once the rest timer stores it.
  // Either way it reads the store, not the last snapshot: that one is rebuilt in
  // an effect after React renders a store write, so a tick landing just after
  // the timer was switched on would still read 'off' there.
  useEffect(
    () =>
      subscribeSessionTimerTicks(({ climbedAt, climbedAtMs, nowMs: tickNowMs }) => {
        const restTimerArmed = isArmedForThisPhone(getRestTimerState(), sessionIdRef.current);
        savedTickAtRef.current = restTimerArmed ? climbedAt : null;
        const command = deriveSessionTimerTickCommand({ restTimerArmed, climbedAtMs, nowMs: tickNowMs });
        if (command) queueRef.current?.push(command);
      }),
    [],
  );

  return null;
}
