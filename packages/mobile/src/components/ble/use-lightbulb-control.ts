import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { useOptionalQuantumBluetoothActions } from '../../providers/quantum-bluetooth-provider';
import { useToast } from '../../providers/toast-provider';
import { derivePlayDrawerLightbulbPressAction } from '../play-drawer/lightbulb-control';
import { useBoardConnectionState } from './use-board-connection-state';

type UseLightbulbControlOptions = {
  /**
   * Opens the BLE controls sheet (Re-light / Turn off all lights / Disconnect).
   * Wired to the returned `onLongPress` so every lightbulb shares one gesture
   * vocabulary: short press connects/disconnects, long press (when connected)
   * opens the labelled controls. Omit on surfaces with no long-press affordance.
   */
  onOpenControls?: () => void;
};

export type LightbulbControl = {
  /** The BLE context, or null when no board is selected yet. Render nothing then. */
  bluetooth: ReturnType<typeof useOptionalBluetoothContext>;
  /**
   * Filled/lit visual: this device is driving the wall, or — in a session —
   * someone else is. Drives the bulb's fill + colour. See `deriveLightbulbLit`.
   */
  lit: boolean;
  /**
   * Whether THIS device holds the BLE link. Drives what a tap does (disconnect
   * vs connect/take-over) and therefore the accessibility label + selected
   * state — distinct from `lit`, which a peer can turn on.
   */
  localConnected: boolean;
  /** A connect/disconnect is in flight — the bulb pulses while pending. */
  pending: boolean;
  /** Whether the active platform can expose a BLE transport. */
  available: boolean;
  /** Quantum uses an explicit four-layer sheet instead of auto-sending. */
  isQuantum: boolean;
  /** Connect (relighting the remembered board) / disconnect toggle. */
  onPress: () => void;
  /**
   * Long-press: opens the BLE controls sheet when this device holds the link.
   * No-op when disconnected (short press connects) or when no `onOpenControls`
   * was supplied.
   */
  onLongPress: () => void;
};

/**
 * Shared connect/disconnect behaviour and lit state for every lightbulb: the iOS
 * glass toolbar FAB, the Android app-bar action, and the play-drawer action bar.
 * Keeping all three on one hook means they light and toggle identically — the
 * toolbar bulb now reflects a session peer driving the wall, not just this
 * device, and there's a single connect/disconnect code path.
 *
 * Reads are non-throwing where the caller might render before a provider mounts
 * (`useOptionalBluetoothContext`, the raw board-presence context); the session
 * controls and board-presence controls are always present under the tab tree.
 */
export function useLightbulbControl(options: UseLightbulbControlOptions = {}): LightbulbControl {
  const { onOpenControls } = options;
  const quantumActions = useOptionalQuantumBluetoothActions();
  const { showToast } = useToast();
  const { t } = useTranslation('common');
  // Ownership/lit derivation is shared with the Live Activity bridge via this
  // hook so the in-app bulb and the lock-screen bulb can never disagree.
  const { bluetooth, lit, localConnected, pending, isQuantum, controlAvailable } = useBoardConnectionState();

  const onPress = useCallback(() => {
    if (isQuantum) {
      if (!quantumActions || pending || !controlAvailable) return;
      // Quantum never auto-sends a queue/current climb. A connected tap opens
      // the four fixed layer choices; a disconnected tap only connects.
      if (localConnected) {
        onOpenControls?.();
      } else {
        void quantumActions
          .connect()
          .then((connected) => {
            if (!connected) showToast(t('bluetooth.connectFailed'), 'error');
          })
          .catch(() => showToast(t('bluetooth.connectFailed'), 'error'));
      }
      return;
    }
    if (!bluetooth) return;
    const pressAction = derivePlayDrawerLightbulbPressAction({
      // Guaranteed non-null by the guard above.
      hasBluetooth: true,
      isBluetoothConnected: bluetooth.isConnected,
      isBluetoothLoading: bluetooth.loading,
    });
    if (pressAction === 'noop') return;

    if (pressAction === 'disconnect') {
      void bluetooth.disconnect();
      return;
    }

    // connect — relight the remembered board for the current config. The board
    // auto-pushes the displayed climb on connect, which reports to board presence
    // and makes this device the holder; on disconnect the bluetooth provider
    // fires the release itself, so we don't report here.
    // The connect ATTEMPT is not tracked — Bluetooth Connection Success / Failed
    // record the outcome a few hundred ms later, which is the question the BLE
    // health dashboard actually asks.
    bluetooth.armUndoWallChangeToast();
    // Reconnect straight to the same board — by serial (Aurora) or device id
    // (MoonBoard). With neither remembered, the adapter opens the picker.
    void bluetooth.connect(
      undefined,
      undefined,
      bluetooth.reconnectSerialForCurrentBoard ?? undefined,
      bluetooth.reconnectDeviceIdForCurrentBoard ?? undefined,
    );
  }, [bluetooth, controlAvailable, isQuantum, localConnected, onOpenControls, pending, quantumActions, showToast, t]);

  const onLongPress = useCallback(() => {
    // Long-press is a power-user shortcut into the controls sheet; only meaningful
    // while THIS device holds the link (the sheet self-guards too). Disconnected,
    // long-press does nothing — short press connects.
    if (!localConnected) return;
    onOpenControls?.();
  }, [localConnected, onOpenControls]);

  return {
    bluetooth,
    lit,
    localConnected,
    pending,
    available: controlAvailable,
    isQuantum,
    onPress,
    onLongPress,
  };
}
