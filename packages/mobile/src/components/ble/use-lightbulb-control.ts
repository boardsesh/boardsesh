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
  /**
   * Put the climb this surface is displaying onto the wall a session peer is
   * driving, by making it the session's current climb. The holder's auto-sender
   * writes whatever is current (see the peer-held wall LED link in
   * `queue-provider`), so this lights the climb over THEIR Bluetooth link
   * without this device touching BLE at all.
   *
   * Supplied only by surfaces that have a displayed climb to relay (PlayDrawer).
   * Omitted on the toolbar and app-bar bulbs, which have none.
   */
  onRelayToHolder?: () => void;
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
  /**
   * Connect (relighting the remembered board) / disconnect toggle — or, while a
   * session peer authoritatively holds the board, the relay described on
   * `onRelayToHolder`.
   */
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
  const { onOpenControls, onRelayToHolder } = options;
  // Ownership/lit derivation is shared with the Live Activity bridge via this
  // hook so the in-app bulb and the lock-screen bulb can never disagree.
  const { bluetooth, lit, localConnected, pending, holderIsAuthoritative } = useBoardConnectionState();

  const onPress = useCallback(() => {
    if (!bluetooth) return;
    const pressAction = derivePlayDrawerLightbulbPressAction({
      // Guaranteed non-null by the guard above.
      hasBluetooth: true,
      isBluetoothConnected: bluetooth.isConnected,
      isBluetoothLoading: bluetooth.loading,
      holderIsAuthoritative,
      canRelay: onRelayToHolder != null,
    });
    if (pressAction === 'noop') return;

    if (pressAction === 'disconnect') {
      void bluetooth.disconnect();
      return;
    }

    // A peer is driving: light the climb through their link instead of opening
    // a second one the board will not accept. No BLE is touched here.
    if (pressAction === 'relay') {
      onRelayToHolder?.();
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
  }, [bluetooth, holderIsAuthoritative, onRelayToHolder]);

  const onLongPress = useCallback(() => {
    // Long-press is a power-user shortcut into the controls sheet; only meaningful
    // while THIS device holds the link (the sheet self-guards too). Disconnected,
    // long-press does nothing — short press connects.
    if (!localConnected) return;
    onOpenControls?.();
  }, [localConnected, onOpenControls]);

  return { bluetooth, lit, localConnected, pending, onPress, onLongPress };
}
