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
  // The connect-step test's (#5654) Climbs card. Its play-view pill
  // ('first_connect_pill') went in #7000 and sends nothing now.
  | 'first_connect_card'
  // The play view's Put on the wall while no board is connected (#6939): the
  // tap sets the preview and connects, so it reads apart from Connect board.
  | 'put_on_wall'
  // The player's Put on {board}: a climb on another board at this gym, so the
  // tap moves to that board first (#7076).
  | 'move_to_board'
  // The Climbs header's "You have the board" capsule: a tap disconnects, a
  // long-press opens the controls sheet. It never connects (it only shows while
  // you hold the board, and a tap that would connect is dropped), but it shares
  // the bulbs' press path.
  | 'header_pill';

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
 * board" pill. The play drawer hosts its own sheet and counts it as
 * `play_drawer` with a `source` (#7000).
 */
export type BoardControlsSurface = Extract<
  BoardConnectSurface,
  'play_drawer' | 'toolbar' | 'app_bar' | 'board_control_indicator' | 'first_connect_card' | 'header_pill'
>;

/**
 * How the player's own sheet was opened (#7000): a hold on one view of the
 * board control (`button`, `bulb`, or the open Duo's `mini_bar`), or ⋯ › Board
 * controls (`player_menu`). A tap never opens it: on You have the board a tap
 * disconnects.
 */
export type PlayerBoardControlsSource = 'button' | 'bulb' | 'mini_bar' | 'player_menu';

export type BoardControlsSource = {
  surface: BoardControlsSurface;
  placement?: AccessoryPlacement;
  /** The player's sheet only. */
  source?: PlayerBoardControlsSource;
};

/** Fired when the controls sheet actually opens (this device holds the link). */
export function trackBoardControlsOpened({ surface, placement, source }: BoardControlsSource): void {
  track(SHARED_EVENTS.BoardControlsOpened, {
    surface,
    ...(placement ? { placement } : {}),
    ...(source ? { source } : {}),
  });
}
