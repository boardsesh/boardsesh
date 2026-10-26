import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from './analytics';

/**
 * Every control that starts a Bluetooth connect. Board Connect Tapped is the
 * leading metric for the #5654 connect step, so a new connect entry point
 * belongs in this union rather than being left untracked.
 */
export type BoardConnectSurface =
  | 'play_drawer'
  | 'toolbar'
  | 'app_bar'
  | 'board_control_indicator'
  | 'wall_empty_state'
  | 'wall_kiosk'
  | 'create_climb'
  | 'picker_scan_again'
  // Android's ongoing-session notification bulb, when the board was out.
  | 'notification'
  // The connect-step test's (#5654) Climbs card, and its labelled play-view
  // pill. The pill is the play drawer's bulb with a label, so without its own
  // surface its taps would read as 'play_drawer' and the treatment's new entry
  // point could not be told apart from the bare bulb it replaces.
  | 'first_connect_card'
  | 'first_connect_pill';

/**
 * Where the iOS 26 tab-bar accessory platter sits: open above the bar, or
 * collapsed inline with it. Sent only by the platter's own controls, so a
 * `board_control_indicator` tap without it came from the floating JS capsule.
 */
export type AccessoryPlacement = 'regular' | 'inline';

type BoardConnectTappedProperties = {
  surface: BoardConnectSurface;
  placement?: AccessoryPlacement;
  boardName: string | undefined;
  /** A remembered board is targeted (silent auto-select) rather than the picker. */
  reconnect: boolean;
};

/**
 * Fired on the tap, before permissions or scanning. Bluetooth Scan Started and
 * the connection outcome events only fire once a connect gets that far, so a tap
 * that dies at a denied permission or a radio that's off shows up only here.
 */
export function trackBoardConnectTapped({
  surface,
  placement,
  boardName,
  reconnect,
}: BoardConnectTappedProperties): void {
  track(SHARED_EVENTS.BoardConnectTapped, { surface, ...(placement ? { placement } : {}), boardName, reconnect });
}

/**
 * Every control that opens the Bluetooth controls sheet (Re-light / Turn off /
 * Disconnect): a lightbulb's long-press, or the Climbs header's "You have the
 * board" pill. The play drawer hosts its own sheet and is not counted.
 */
export type BoardControlsSurface =
  | Extract<
      BoardConnectSurface,
      'play_drawer' | 'toolbar' | 'app_bar' | 'board_control_indicator' | 'first_connect_card' | 'first_connect_pill'
    >
  | 'header_pill';

export type BoardControlsSource = {
  surface: BoardControlsSurface;
  placement?: AccessoryPlacement;
};

/** Fired when the controls sheet actually opens (this device holds the link). */
export function trackBoardControlsOpened({ surface, placement }: BoardControlsSource): void {
  track(SHARED_EVENTS.BoardControlsOpened, { surface, ...(placement ? { placement } : {}) });
}
