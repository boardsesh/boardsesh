export type PlayDrawerLightbulbPressAction = 'noop' | 'connect' | 'disconnect' | 'takeWall' | 'releaseWall';

export function derivePlayDrawerLightbulbPressAction(args: {
  hasBluetooth: boolean;
  isBluetoothConnected: boolean;
  isBluetoothLoading: boolean;
  /** The board is flagged as having no LED light kit (`hasLeds === false`). */
  ledless?: boolean;
  /** This device holds the wall with no Bluetooth link. */
  wallHeld?: boolean;
}): PlayDrawerLightbulbPressAction {
  // No board selected yet, or a connect/disconnect already in flight — ignore.
  if (!args.hasBluetooth || args.isBluetoothLoading) return 'noop';
  // Connected state wins, always. A ledless board can still end up with a live
  // link — the creator header's Bluetooth toggle, or an iOS reconnect intent for
  // a previously paired box — and the user must be able to hang it up. This is
  // also the recovery path when a board is wrongly flagged as having no lights.
  if (args.isBluetoothConnected) return 'disconnect';
  if (args.wallHeld) return 'releaseWall';
  // A wall with no lights has nothing to connect to; the tap takes the wall.
  if (args.ledless) return 'takeWall';
  return 'connect';
}

/**
 * Tri-state board-connection ownership from THIS device's point of view. Drives
 * both the in-app lightbulb and the Live Activity (lock screen + Dynamic
 * Island), so the two never disagree:
 *  - `connectedByMe`: this device holds the BLE link → bulb lit, Previous/Next
 *    shown (they write BLE to the wall).
 *  - `heldByPeer`: someone I'm climbing with (a session member, or an anonymous
 *    holder while I'm in a session) is driving the wall → bulb out, Previous/Next
 *    hidden, show the climb on the wall.
 *  - `disconnected`: nobody I can tie to is driving → bulb out (tap to reconnect),
 *    Previous/Next hidden.
 *
 * The signal is session-scoped, but the board-presence holder is board-scoped
 * (anyone physically on the same board feed can be the holder — a stranger when
 * you're solo, or a non-member when you're in a session). So we don't light from
 * the bare holder; we light from a holder we can tie to the session:
 *  - `sessionHolderPresent` — a board-presence holder whose userId matches a
 *    member of my session (incl. me). Authoritative: the holder is server-owned,
 *    seq-gated, with a reliable compare-and-delete broadcast on disconnect and a
 *    WS-drop backstop, so it clears reliably. This is what stops the bulb getting
 *    stuck lit on a phone that handed off control.
 *  - `isSessionWallLit` is a best-effort session UI flag toggled by
 *    WallConfirmedClimb / WallDisconnected with no reconciliation — a missed or
 *    late "disconnected" event leaves it stuck `true`. It's only consulted as a
 *    fallback for an *anonymous* holder (no userId to id-match) while in a session,
 *    or for a session member who never bound the board feed (no holder to read).
 *
 * Net effect: a board holder who isn't part of my session (or any holder while I'm
 * solo) no longer lights my bulb, while the holder's avatar still shows separately.
 */
export type BoardConnection = 'connectedByMe' | 'heldByPeer' | 'disconnected';

export function deriveBoardConnection(args: {
  localConnected: boolean;
  isSubscribedToBoardFeed: boolean;
  /**
   * A board-presence holder whose userId matches a member of my session (incl.
   * me). Mutually exclusive with `holderIsAnonymous`: a holder either has a
   * matchable userId or is anonymous, never both.
   */
  sessionHolderPresent: boolean;
  /** The current holder is anonymous (exists, userId == null) AND I'm in a session. */
  holderIsAnonymous: boolean;
  /** Best-effort session "a member lit a climb" flag. */
  isSessionWallLit: boolean;
}): BoardConnection {
  if (args.localConnected) return 'connectedByMe';
  // No board feed bound: no holder to trust; fall back to the session flag
  // (only ever true inside a session). A lit session means a peer is driving.
  if (!args.isSubscribedToBoardFeed) return args.isSessionWallLit ? 'heldByPeer' : 'disconnected';
  // Subscribed: trust the authoritative holder, but only a session member's.
  if (args.sessionHolderPresent) return 'heldByPeer';
  // Anonymous holder can't be id-matched; fall back to the session flag, but only
  // while a holder actually exists (a cleared holder + stuck flag still reads off).
  if (args.holderIsAnonymous && args.isSessionWallLit) return 'heldByPeer';
  return 'disconnected';
}

/**
 * Whether the lightbulb reads lit: this device is driving the wall, or someone
 * *in this user's session* is. Shared by the header toolbar bulb and the
 * play-drawer bulb so both light identically. Expressed in terms of
 * {@link deriveBoardConnection} so the bulb and the Live Activity stay in lockstep
 * (lit ⇔ not disconnected). See `deriveBoardConnection` for the holder-vs-session
 * rationale.
 */
export function deriveLightbulbLit(args: {
  localConnected: boolean;
  isSubscribedToBoardFeed: boolean;
  sessionHolderPresent: boolean;
  holderIsAnonymous: boolean;
  isSessionWallLit: boolean;
}): boolean {
  return deriveBoardConnection(args) !== 'disconnected';
}

/**
 * In-app widening of {@link deriveBoardConnection} for a wall with no lights.
 *
 * Kept SEPARATE from `deriveBoardConnection` on purpose: that function is the
 * Live Activity contract (lock-screen bulb, Prev/Next, and both native iOS
 * intents), and a virtual hold must not light the lock screen or arm widget
 * navigation — there is no radio behind it to write the wall. Only in-app
 * surfaces read this value.
 *
 * `wallHeldByOtherUser` is what a virtual hold has instead of the radio's
 * exclusivity: the server keeps one last-write-wins holder slot, so a phone
 * whose local `wallHeld` is still true but whose slot went to someone else is
 * showing a stale claim, and must read as a peer's wall rather than its own.
 */
export function deriveInAppBoardConnection(args: {
  boardConnection: BoardConnection;
  wallHeld: boolean;
  wallHeldByOtherUser: boolean;
}): BoardConnection {
  if (args.wallHeld && args.wallHeldByOtherUser) return 'heldByPeer';
  if (args.wallHeld) return 'connectedByMe';
  return args.boardConnection;
}
