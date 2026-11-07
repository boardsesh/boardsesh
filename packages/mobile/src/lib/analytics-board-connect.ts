import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from './analytics';
import { getFirstConnectSnapshot } from './onboarding/first-connect-store';

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
 * `board_control_indicator` tap without it came from a JS bar: the floating
 * glass capsule or the Material MiniPlayer card.
 */
export type AccessoryPlacement = 'regular' | 'inline';

type BoardConnectTappedProperties = {
  surface: BoardConnectSurface;
  placement?: AccessoryPlacement;
  boardName: string | undefined;
  /** A remembered board is targeted (silent auto-select) rather than the picker. */
  reconnect: boolean;
  /**
   * The board this connect is for, when the caller knows it better than the
   * Bluetooth provider does (a move to another gym board). Omitted, it is the
   * provider's selected board (`registerConnectBoardUuidReader`).
   */
  boardUuid?: string | null;
};

/** How long after a connect tap a picker list counts as that tap's (`entrySurface`). */
export const BOARD_CONNECT_ENTRY_WINDOW_MS = 2 * 60_000;

let lastConnectTap: { surface: BoardConnectSurface; at: number } | null = null;
let connectBoardUuidReader: (() => string | null) | null = null;

/**
 * The Bluetooth provider's reader of the board it would connect to (its gym or
 * saved board's uuid), for Board Connect Tapped. Returns the unregister, which
 * only clears its own reader.
 */
export function registerConnectBoardUuidReader(reader: () => string | null): () => void {
  connectBoardUuidReader = reader;
  return () => {
    if (connectBoardUuidReader === reader) connectBoardUuidReader = null;
  };
}

/**
 * This phone has never connected to a board (the connect-step test's record,
 * #5654), or null while that record hasn't loaded. Read synchronously: no
 * await on a tap or a picker close.
 */
export function readPhoneNeverConnected(): boolean | null {
  const device = getFirstConnectSnapshot().device;
  return device ? device.connectedAt === null : null;
}

/**
 * The surface of the connect tap a picker list opening now belongs to: the last
 * Board Connect Tapped, if it came within `BOARD_CONNECT_ENTRY_WINDOW_MS`.
 */
export function readRecentBoardConnectSurface(now = Date.now()): BoardConnectSurface | null {
  if (!lastConnectTap || now - lastConnectTap.at > BOARD_CONNECT_ENTRY_WINDOW_MS) return null;
  return lastConnectTap.surface;
}

/** Tests only: no tap seen, no provider reader. */
export function resetBoardConnectTapsForTests(): void {
  lastConnectTap = null;
  connectBoardUuidReader = null;
}

/**
 * Fired on the tap, before permissions or scanning. Bluetooth Scan Started and
 * the connection outcome events only fire once a connect gets that far, so a tap
 * that dies at a denied permission or a radio that's off shows up only here.
 * 2.7 adds `boardUuid` and `phoneNeverConnected` when they are known, so the
 * release watch reads a newcomer's first connect apart from a regular's.
 */
export function trackBoardConnectTapped({
  surface,
  placement,
  boardName,
  reconnect,
  boardUuid,
}: BoardConnectTappedProperties): void {
  lastConnectTap = { surface, at: Date.now() };
  const targetBoardUuid = boardUuid === undefined ? (connectBoardUuidReader?.() ?? null) : boardUuid;
  const phoneNeverConnected = readPhoneNeverConnected();
  track(SHARED_EVENTS.BoardConnectTapped, {
    surface,
    ...(placement ? { placement } : {}),
    boardName,
    reconnect,
    ...(targetBoardUuid ? { boardUuid: targetBoardUuid } : {}),
    ...(phoneNeverConnected === null ? {} : { phoneNeverConnected }),
  });
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
 * controls (`player_menu`). A tap never opens it: on Disconnect board a tap
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
