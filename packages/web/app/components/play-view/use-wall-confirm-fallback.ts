'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  createWallConfirmFallbackController,
  subscribeToWallConfirm,
  WALL_CONFIRM_BACKSTOP_MS,
  WALL_CONFIRM_TIMEOUT_MS,
  type WallConfirmArmArgs,
} from '@boardsesh/play-view';
import { track } from '@/app/lib/analytics';
import { isNativeApp } from '@/app/lib/ble/capacitor-utils';

export { WALL_CONFIRM_BACKSTOP_MS, WALL_CONFIRM_TIMEOUT_MS };

type Deps = {
  /** Current local BLE connection state. */
  isBluetoothConnected: boolean;
  /** Whether Web Bluetooth or a Capacitor BLE bridge is available. */
  isBluetoothSupported: boolean;
  /** Stored session board serial (party), or null in solo / unknown. */
  lastConnectedBoardSerial: string | null;
  /** Whether a persistent party session is active. When the session ends
   *  mid-window, the in-flight watcher should cancel silently so the picker
   *  doesn't pop up after the user already left. */
  isPersistentSessionActive: boolean;
  /** BluetoothProvider's `connect` from `useBluetoothContext()`. */
  bluetoothConnect: (frames?: string, mirrored?: boolean, targetSerial?: string) => Promise<boolean>;
  /** Override for native-shell detection — defaults to `isNativeApp()` from
   *  `@/app/lib/ble/capacitor-utils`. Exposed so tests can drive the
   *  auto-connect branch without monkey-patching Capacitor. */
  isNativeAppOverride?: () => boolean;
};

type Callbacks = {
  /** Fired when a `WallConfirmedClimb` matching the armed `climbUuid` arrives
   *  inside the 2-second window. Receives the elapsed `latencyMs` and a
   *  `confirmedByRole` hint derived from the local BLE state at confirm time
   *  (`'self'` when the local phone is currently BLE-paired — most likely the
   *  AutoSender that just wrote; `'other'` otherwise). The drawer uses this
   *  to fire the `Wall Confirmed` analytics event and clear pending UI. */
  onConfirmed?: (info: { climbUuid: string; latencyMs: number; confirmedByRole: 'self' | 'other' }) => void;
  /** Fired when the 2-second window expires and a fallback ran. */
  onTimeout?: (info: { climbUuid: string }) => void;
};

/**
 * React wrapper around the shared wall-confirm fallback controller.
 * Platform-specific concerns stay injected here: web analytics, native-shell
 * detection, and the current Bluetooth context's connect function.
 */
export function useWallConfirmFallback(deps: Deps, callbacks: Callbacks = {}) {
  const latestDepsRef = useRef(deps);
  const callbacksRef = useRef(callbacks);

  useLayoutEffect(() => {
    latestDepsRef.current = deps;
  }, [deps]);
  useLayoutEffect(() => {
    callbacksRef.current = callbacks;
  }, [callbacks]);

  const controller = useMemo(
    () =>
      createWallConfirmFallbackController(
        {
          isBluetoothConnected: () => latestDepsRef.current.isBluetoothConnected,
          isBluetoothSupported: () => latestDepsRef.current.isBluetoothSupported,
          lastConnectedBoardSerial: () => latestDepsRef.current.lastConnectedBoardSerial,
          isPersistentSessionActive: () => latestDepsRef.current.isPersistentSessionActive,
          bluetoothConnect: (...args) => latestDepsRef.current.bluetoothConnect(...args),
          isNativeApp: () => (latestDepsRef.current.isNativeAppOverride ?? isNativeApp)(),
          subscribeToWallConfirm,
        },
        {
          onConfirmed: (info) => callbacksRef.current.onConfirmed?.(info),
          onTimeout: (info) => callbacksRef.current.onTimeout?.(info),
          onTrackConfirmed: ({ climbUuid, latencyMs, confirmedByRole, mode, boardLayout }) => {
            track('Wall Confirmed', { climbUuid, latencyMs, confirmedByRole, mode, boardLayout });
          },
          onTrackTimeout: ({ mode, fallback, boardLayout }) => {
            // Only the connected-but-no-converge case is a genuine board-ack
            // failure. Everything else (`pulse_only`/`picker`/`auto_connect`/
            // `unsupported`) is the backstop firing while the link was still
            // coming up — not a wall failure. Split it out so it stops inflating
            // the board-ack-failure metric.
            if (fallback === 'already_connected') {
              track('Wall Confirm Timeout', { mode, fallback, boardLayout });
            } else {
              track('Wall Confirm Connecting', { mode, fallback, boardLayout });
            }
          },
        },
      ),
    [],
  );

  const cancelWatcher = useCallback(() => {
    controller.cancelWatcher();
  }, [controller]);

  useEffect(() => {
    return () => {
      controller.cancelWatcher();
    };
  }, [controller]);

  useEffect(() => {
    controller.handleSessionActiveChange();
  }, [controller, deps.isPersistentSessionActive]);

  const armWatcher = useCallback(
    (args: WallConfirmArmArgs) => {
      controller.armWatcher(args);
    },
    [controller],
  );

  return { armWatcher, cancelWatcher };
}

type WallConfirmConvergenceArgs = {
  /** The climb whose pulse is currently armed, or null when idle. */
  pendingClimbUuid: string | null;
  /** The climb the board-presence feed currently shows on the wall, or null. */
  wallCurrentClimbUuid: string | null;
  /** The committed queue climb (what the AutoSender sends), null when the queue
   *  is empty. */
  committedClimbUuid: string | null;
  /** Fired once when the wall *transitions* to the pending climb — feed the
   *  wall-confirm bus so the watcher records the confirm with its true latency. */
  onConfirm: (climbUuid: string) => void;
  /** Fired when the pending climb is superseded — the committed climb moved off
   *  it (queue advanced or emptied). */
  onSupersede: () => void;
};

/**
 * Bridges the convergent board-presence state to the wall-confirm pulse. Two
 * rules:
 *
 *  - **Confirm on transition.** When the wall feed *becomes* the pending climb
 *    (a fresh `BoardClimbSet`, or a reconnect catch-up), fire `onConfirm`. Gate
 *    on the transition (was-not → now-is), never steady-state equality: a tap
 *    while the board already shows the climb is confirmed by the local BLE
 *    write, and a steady-state emit would log a ~0 ms latency that skews the
 *    metric. The first observed wall value is the baseline, not a transition.
 *  - **Supersede.** When the committed climb no longer matches the pending one
 *    — including the queue being emptied (`committedClimbUuid === null`) — fire
 *    `onSupersede` so the pulse clears immediately instead of waiting out the
 *    backstop.
 *
 * Extracted from the drawer so both rules are unit-testable without the full
 * play-view tree.
 */
export function useWallConfirmConvergence({
  pendingClimbUuid,
  wallCurrentClimbUuid,
  committedClimbUuid,
  onConfirm,
  onSupersede,
}: WallConfirmConvergenceArgs): void {
  // `undefined` until the first observed wall value, so a mount that already
  // shows the pending climb is treated as the baseline, not a transition.
  const prevWallClimbUuidRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prevWallClimbUuid = prevWallClimbUuidRef.current;
    prevWallClimbUuidRef.current = wallCurrentClimbUuid;
    if (prevWallClimbUuid === undefined) return;
    if (pendingClimbUuid && wallCurrentClimbUuid === pendingClimbUuid && prevWallClimbUuid !== pendingClimbUuid) {
      onConfirm(pendingClimbUuid);
    }
  }, [wallCurrentClimbUuid, pendingClimbUuid, onConfirm]);

  useEffect(() => {
    if (pendingClimbUuid && committedClimbUuid !== pendingClimbUuid) {
      onSupersede();
    }
  }, [committedClimbUuid, pendingClimbUuid, onSupersede]);
}
