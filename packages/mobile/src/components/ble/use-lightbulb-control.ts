import { useCallback } from 'react';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { track } from '../../lib/analytics';
import { derivePlayDrawerLightbulbPressAction } from '../play-drawer/lightbulb-control';
import { useBoardConnectionState } from './use-board-connection-state';

type LightbulbControlSource = 'lightbulb_toolbar' | 'lightbulb_drawer';

type UseLightbulbControlOptions = {
  /** Where the tap originated, for the connect analytics event. */
  source: LightbulbControlSource;
  /** Board layout key for analytics (the drawer has it; the toolbar doesn't). */
  boardLayout?: string;
  /** Climb the bulb is acting on, for analytics. Null when none is in view. */
  climbUuid?: string | null;
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
export function useLightbulbControl(options: UseLightbulbControlOptions): LightbulbControl {
  const { source, boardLayout, climbUuid } = options;
  // Ownership/lit derivation is shared with the Live Activity bridge via this
  // hook so the in-app bulb and the lock-screen bulb can never disagree.
  const { bluetooth, lit, localConnected, pending, sessionId } = useBoardConnectionState();

  const onPress = useCallback(() => {
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
    track('Board Lightbulb Connect', {
      source,
      mode: sessionId !== null ? 'party' : 'solo',
      boardLayout: boardLayout ?? null,
      climbUuid: climbUuid ?? null,
    });
    bluetooth.armUndoWallChangeToast();
    void bluetooth.connect(undefined, undefined, bluetooth.reconnectSerialForCurrentBoard ?? undefined);
  }, [bluetooth, source, sessionId, boardLayout, climbUuid]);

  return { bluetooth, lit, localConnected, pending, onPress };
}
