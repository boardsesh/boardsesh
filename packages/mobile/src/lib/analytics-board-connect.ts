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
  | 'notification';

type BoardConnectTappedProperties = {
  surface: BoardConnectSurface;
  boardName: string | undefined;
  /** A remembered board is targeted (silent auto-select) rather than the picker. */
  reconnect: boolean;
};

/**
 * Fired on the tap, before permissions or scanning. Bluetooth Scan Started and
 * the connection outcome events only fire once a connect gets that far, so a tap
 * that dies at a denied permission or a radio that's off shows up only here.
 */
export function trackBoardConnectTapped({ surface, boardName, reconnect }: BoardConnectTappedProperties): void {
  track(SHARED_EVENTS.BoardConnectTapped, { surface, boardName, reconnect });
}
