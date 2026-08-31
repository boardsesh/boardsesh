import { useCallback } from 'react';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
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
  /** Connect (relighting the remembered board) / disconnect toggle. */
  onPress: () => void;
  /**
   * Long-press: opens the BLE controls sheet when this device holds the link.
   * No-op when disconnected (short press connects) or when no `onOpenControls`
   * was supplied. Gated on `localConnected` (BLE only), so a virtual hold never
   * offers a Re-light / Turn off / Disconnect sheet for a wall with no lights.
   */
  onLongPress: () => void;
  /** The active board is flagged as having no LED light kit. */
  ledless: boolean;
  /** This device holds the wall with no Bluetooth link. */
  wallHeldLocally: boolean;
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
  // Ownership/lit derivation is shared with the Live Activity bridge via this
  // hook so the in-app bulb and the lock-screen bulb can never disagree.
  const { bluetooth, lit, localConnected, pending, ledless, wallHeldLocally } = useBoardConnectionState();

  const onPress = useCallback(() => {
    if (!bluetooth) return;
    const pressAction = derivePlayDrawerLightbulbPressAction({
      // Guaranteed non-null by the guard above.
      hasBluetooth: true,
      isBluetoothConnected: bluetooth.isConnected,
      isBluetoothLoading: bluetooth.loading,
      ledless: bluetooth.ledless,
      wallHeld: bluetooth.virtualWallHeld,
    });
    if (pressAction === 'noop') return;

    if (pressAction === 'disconnect') {
      void bluetooth.disconnect();
      return;
    }

    // A wall with no lights: no radio to connect to, and nothing to undo — the
    // first take has no previous wall state to restore, so the undo toast stays
    // unarmed. Taking the wall reports the current climb to everyone watching
    // the board feed and to the gym screen.
    //
    // No haptic here. `takeVirtualWall` / `releaseVirtualWall` fire their own
    // `hapticLight` alongside the toast, so buzzing here too would stutter every
    // tap. Same reason WallScrubber and WallEmptyState call them bare.
    if (pressAction === 'takeWall') {
      bluetooth.takeVirtualWall();
      return;
    }

    if (pressAction === 'releaseWall') {
      bluetooth.releaseVirtualWall();
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
  }, [bluetooth]);

  const onLongPress = useCallback(() => {
    // Long-press is a power-user shortcut into the controls sheet; only meaningful
    // while THIS device holds the link (the sheet self-guards too). Disconnected,
    // long-press does nothing — short press connects.
    if (!localConnected) return;
    onOpenControls?.();
  }, [localConnected, onOpenControls]);

  return { bluetooth, lit, localConnected, pending, onPress, onLongPress, ledless, wallHeldLocally };
}
