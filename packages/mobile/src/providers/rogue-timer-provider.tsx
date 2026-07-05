// RogueTimerProvider — connects to and drives a Rogue Fitness workout timer
// (Home Timer 2.0 / Echo Gym Timer 2.0) paired to the active board.
//
// Two hard rules shape this provider:
//
//  1. The timer is *gym equipment paired to a board*. Which timer to talk to
//     comes from the active board's `timerName` (set in the My Boards config),
//     not a global app setting. No pairing → nothing happens.
//
//  2. Only the climber *driving the wall* touches the timer. In a gym several
//     people may have the same board saved with the same paired timer; if each
//     of them fired the timer on their own ticks they'd stomp on each other. So
//     the timer is only connected while this user holds the board LED connection
//     (`useOptionalBluetoothContext().isConnected` — the lightbulb is on). When
//     the board disconnects, we drop the timer too.
//
// The imperative surface (`pressButton`, `reset`, `startStopwatch`) is kept
// general so the future sessions/workout driver can reuse this same controller
// to program interval / EMOM / countdown timers per workout step. The
// "start a stopwatch on tick" POC is just one thin caller of `startStopwatch()`.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RogueTimerCommand, type RogueTimerCommandCode } from '@boardsesh/ble-protocol/rogue-timer';
import { RogueTimerController } from '../lib/ble/rogue-timer-ble';
import { useActiveBoard } from '../lib/graphql/use-active-board';
import { useOptionalBluetoothContext } from './bluetooth-provider';

export type RogueTimerStatus = 'idle' | 'connecting' | 'connected' | 'error';

type RogueTimerContextValue = {
  status: RogueTimerStatus;
  isConnected: boolean;
  deviceName: string | undefined;
  /** Press a single remote button (raw key-code) — the general escape hatch. */
  pressButton: (code: RogueTimerCommandCode) => Promise<void>;
  /** Clear the stopwatch to 0:00. */
  reset: () => Promise<void>;
  /**
   * Reset the stopwatch to zero and start it counting up. This is the POC
   * behaviour fired on every tick. No-op unless a timer is connected (which only
   * happens while this user is driving the wall), so a passenger's tick can't
   * touch the timer.
   */
  startStopwatch: () => Promise<void>;
};

const RogueTimerContext = createContext<RogueTimerContextValue | undefined>(undefined);

// Gap between composed key presses. The timer is a slow HM-10 UART display;
// back-to-back frames can be dropped, so we space the STOPWATCH → RESET → OK
// sequence out. Tune on-device — we can't exercise real hardware in CI.
const KEY_SEQUENCE_GAP_MS = 180;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function RogueTimerProvider({ children }: { children: ReactNode }) {
  const { data: activeBoard } = useActiveBoard();
  const bluetooth = useOptionalBluetoothContext();
  const boardConnected = bluetooth?.isConnected ?? false;
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
  // Bumped when the connected timer drops unexpectedly, to re-run the reconcile
  // effect for a single reconnect attempt (while the board LED is still held).
  const [reconnectTick, setReconnectTick] = useState(0);

  // Reconcile the timer connection with "driving the wall + a paired timer".
  // Connects when both become true; disconnects when either goes false, the
  // board changes, or the pairing is cleared.
  useEffect(() => {
    const shouldConnect = boardConnected && timerName !== null;
    let cancelled = false;
    let unsubscribeDisconnect: (() => void) | undefined;

    if (shouldConnect) {
      if (connectedTargetRef.current === timerName) return;
      connectedTargetRef.current = timerName;
      setStatus('connecting');
      controller
        .connectByName(timerName)
        .then((connection) => {
          if (cancelled) {
            void controller.disconnect();
            return;
          }
          setStatus('connected');
          setDeviceName(connection.deviceName ?? timerName);
          // Reflect an unsolicited drop (out of range / powered off): the
          // controller clears its own refs, but the provider must clear the
          // target + status too, or the badge stays stuck on "connected" and
          // the reconcile guard blocks any reconnect. Bumping reconnectTick
          // re-runs this effect for one reconnect attempt while the board LED
          // is still held.
          unsubscribeDisconnect = controller.onDisconnect(() => {
            connectedTargetRef.current = null;
            setDeviceName(undefined);
            setStatus('idle');
            setReconnectTick((tick) => tick + 1);
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
    } else if (connectedTargetRef.current !== null) {
      connectedTargetRef.current = null;
      setStatus('idle');
      setDeviceName(undefined);
      void controller.disconnect();
    }

    return () => {
      cancelled = true;
      unsubscribeDisconnect?.();
    };
  }, [controller, boardConnected, timerName, reconnectTick]);

  // Drop the connection when the provider unmounts (app teardown).
  useEffect(() => {
    return () => {
      void controller.disconnect();
    };
  }, [controller]);

  const pressButton = useCallback(
    async (code: RogueTimerCommandCode) => {
      if (!controller.isConnected()) return;
      await controller.pressButton(code);
    },
    [controller],
  );

  const reset = useCallback(async () => {
    if (!controller.isConnected()) return;
    await controller.pressButton(RogueTimerCommand.RESET);
  }, [controller]);

  const startStopwatch = useCallback(async () => {
    if (!controller.isConnected()) return;
    // Enter stopwatch mode, zero it, then start counting. Assumes the timer is
    // at its top-level screen (not buried in a setup sub-menu) — the STOPWATCH
    // key selects the mode from the home screen; there is no telemetry back, so
    // a wrong precondition fails silently. Fire-and-forget: a dropped frame
    // shouldn't reject the tick's success handler.
    try {
      await controller.pressButton(RogueTimerCommand.STOPWATCH);
      await wait(KEY_SEQUENCE_GAP_MS);
      await controller.pressButton(RogueTimerCommand.RESET);
      await wait(KEY_SEQUENCE_GAP_MS);
      await controller.pressButton(RogueTimerCommand.OK);
    } catch {
      // Best-effort — the timer is a display, not a source of truth.
    }
  }, [controller]);

  const value = useMemo<RogueTimerContextValue>(
    () => ({
      status,
      isConnected: status === 'connected',
      deviceName,
      pressButton,
      reset,
      startStopwatch,
    }),
    [status, deviceName, pressButton, reset, startStopwatch],
  );

  return <RogueTimerContext.Provider value={value}>{children}</RogueTimerContext.Provider>;
}

export function useRogueTimer(): RogueTimerContextValue {
  const ctx = useContext(RogueTimerContext);
  if (!ctx) throw new Error('useRogueTimer must be used within a RogueTimerProvider');
  return ctx;
}

/** Non-throwing variant for consumers that may render outside the provider. */
export function useOptionalRogueTimer(): RogueTimerContextValue | null {
  return useContext(RogueTimerContext) ?? null;
}
