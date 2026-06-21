/**
 * Shared controller for the wall-confirm fallback flow used by web and mobile.
 *
 * This logic was extracted from the original web hook and made
 * platform-neutral for React Native by injecting BLE, native-shell, timer, and
 * event-bus dependencies. When a user claims the wall, both platforms wait
 * briefly for a WallConfirmedClimb event. If no confirm arrives, this
 * controller decides whether to skip fallback, auto-connect to the last board,
 * or open the board picker so web and mobile do not each carry their own
 * timer/listener/fallback implementation.
 */
export const WALL_CONFIRM_TIMEOUT_MS = 2000;

export type WallConfirmMode = 'party' | 'solo';
export type WallConfirmFallback = 'already_connected' | 'unsupported' | 'auto_connect' | 'picker' | 'pulse_only';

export type WallConfirmArmArgs = {
  climbUuid: string;
  mode: WallConfirmMode;
  boardLayout: string;
  /**
   * Drive the pulse/confirm UI but never connect on timeout. Set this when the
   * caller has *itself* just initiated a connect (the always-live lightbulb tap
   * does this): re-connecting 2s later is at best redundant (a successful
   * connect already short-circuits via `already_connected`) and at worst a
   * second native scan started while the first picker is still open — which
   * trips "Already scanning. Stopping now." on the iOS shell. The watcher still
   * waits for `WallConfirmedClimb` and fires `onConfirmed` / `onTimeout` to
   * clear the pulse; only the connect fallback is suppressed.
   */
  pulseOnly?: boolean;
};

type WallConfirmTimeoutId = ReturnType<typeof setTimeout>;

export type WallConfirmControllerDeps = {
  isBluetoothConnected: () => boolean;
  isBluetoothSupported: () => boolean;
  lastConnectedBoardSerial: () => string | null;
  isPersistentSessionActive: () => boolean;
  bluetoothConnect: (frames?: string, mirrored?: boolean, targetSerial?: string) => Promise<boolean>;
  isNativeApp: () => boolean;
  subscribeToWallConfirm: (callback: (climbUuid: string) => void) => () => void;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => WallConfirmTimeoutId;
  clearTimeout?: (timeoutId: WallConfirmTimeoutId) => void;
};

export type WallConfirmControllerCallbacks = {
  onConfirmed?: (info: { climbUuid: string; latencyMs: number; confirmedByRole: 'self' | 'other' }) => void;
  onTimeout?: (info: { climbUuid: string }) => void;
  onTrackConfirmed?: (info: {
    climbUuid: string;
    latencyMs: number;
    confirmedByRole: 'self' | 'other';
    mode: WallConfirmMode;
    boardLayout: string;
  }) => void;
  onTrackTimeout?: (info: { mode: WallConfirmMode; fallback: WallConfirmFallback; boardLayout: string }) => void;
};

type Watcher = { timeoutId: WallConfirmTimeoutId; unsubscribe: () => void };

export type WallConfirmFallbackController = {
  armWatcher: (args: WallConfirmArmArgs) => void;
  cancelWatcher: () => void;
  handleSessionActiveChange: () => void;
};

export function createWallConfirmFallbackController(
  deps: WallConfirmControllerDeps,
  callbacks: WallConfirmControllerCallbacks = {},
): WallConfirmFallbackController {
  let watcher: Watcher | null = null;
  const getNow = deps.now ?? Date.now;
  const scheduleTimeout: NonNullable<WallConfirmControllerDeps['setTimeout']> =
    deps.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs) as WallConfirmTimeoutId);
  const cancelTimeout: NonNullable<WallConfirmControllerDeps['clearTimeout']> =
    deps.clearTimeout ?? ((timeoutId) => clearTimeout(timeoutId));

  const cancelWatcher = () => {
    if (!watcher) return;
    cancelTimeout(watcher.timeoutId);
    watcher.unsubscribe();
    watcher = null;
  };

  const handleSessionActiveChange = () => {
    if (!deps.isPersistentSessionActive() && watcher) {
      cancelWatcher();
    }
  };

  const armWatcher = ({ climbUuid, mode, boardLayout, pulseOnly = false }: WallConfirmArmArgs) => {
    cancelWatcher();

    const armedAt = getNow();
    let capturedTimeoutId: WallConfirmTimeoutId | null = null;

    const runFallback = () => {
      if (watcher?.timeoutId !== capturedTimeoutId) return;

      cancelWatcher();
      callbacks.onTimeout?.({ climbUuid });

      // The caller already kicked off its own connect — never start another one
      // (the second scan is what breaks iOS pairing). Just record the timeout.
      if (pulseOnly) {
        callbacks.onTrackTimeout?.({ mode, fallback: 'pulse_only', boardLayout });
        return;
      }

      if (deps.isBluetoothConnected()) {
        callbacks.onTrackTimeout?.({ mode, fallback: 'already_connected', boardLayout });
        return;
      }
      if (!deps.isBluetoothSupported()) {
        callbacks.onTrackTimeout?.({ mode, fallback: 'unsupported', boardLayout });
        return;
      }

      const serial = deps.lastConnectedBoardSerial();
      if (serial && deps.isNativeApp()) {
        callbacks.onTrackTimeout?.({ mode, fallback: 'auto_connect', boardLayout });
        void deps.bluetoothConnect(undefined, undefined, serial);
        return;
      }

      callbacks.onTrackTimeout?.({ mode, fallback: 'picker', boardLayout });
      void deps.bluetoothConnect();
    };

    const unsubscribe = deps.subscribeToWallConfirm((confirmedUuid) => {
      if (watcher?.timeoutId !== capturedTimeoutId) return;
      if (confirmedUuid !== climbUuid) return;
      const latencyMs = getNow() - armedAt;
      const confirmedByRole: 'self' | 'other' = deps.isBluetoothConnected() ? 'self' : 'other';
      cancelWatcher();
      callbacks.onConfirmed?.({ climbUuid, latencyMs, confirmedByRole });
      callbacks.onTrackConfirmed?.({ climbUuid, latencyMs, confirmedByRole, mode, boardLayout });
    });

    capturedTimeoutId = scheduleTimeout(runFallback, WALL_CONFIRM_TIMEOUT_MS);
    watcher = { timeoutId: capturedTimeoutId, unsubscribe };
  };

  return { armWatcher, cancelWatcher, handleSessionActiveChange };
}
