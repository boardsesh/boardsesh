export type PlayDrawerLightbulbPressAction = 'noop' | 'connect' | 'disconnect' | 'takeWall' | 'releaseWall' | 'relay';

export function derivePlayDrawerLightbulbPressAction(args: {
  hasBluetooth: boolean;
  isBluetoothConnected: boolean;
  isBluetoothLoading: boolean;
  /** The board is flagged as having no LED light kit (`hasLeds === false`). */
  ledless?: boolean;
  /** This device holds the wall with no Bluetooth link. */
  wallHeld?: boolean;
  /**
   * A session peer AUTHORITATIVELY holds the BLE link — the server-owned,
   * seq-gated board-presence holder (`sessionHolderPresent`), never the
   * best-effort `isSessionWallLit` flag. See {@link deriveBoardConnection} for
   * why that distinction matters: the flag has no reconciliation and can stick
   * `true` after a missed event, and keying the connect suppression on it would
   * strand a climber with a bulb that no longer connects to anything.
   */
  holderIsAuthoritative: boolean;
  /**
   * The call site can put the climb it is displaying onto the peer's wall by
   * making it the session's current climb (PlayDrawer). Surfaces with no
   * displayed climb to relay — the toolbar and app-bar bulbs — pass `false`.
   */
  canRelay: boolean;
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
  // Someone I'm climbing with is driving the wall. A connect from here would
  // either take it from them or fail:
  //   - Most boxes (Kilter, Tension, the other Aurora boards, most MoonBoards)
  //     are last-connection-wins: the connect links and silently drops the
  //     crewmate mid-session, with no Undo (2026-10-28 rule).
  //   - Some MoonBoards refuse a second phone while one is linked: the scan
  //     spends ~15 s and shows "Connection failed" over a board that works
  //     (BleError 201 DeviceDisconnected, bucketed `connect_failed` by
  //     `connection-error.ts`, far more common on Android than iOS).
  // Neither is what a plain bulb tap means, so it relays instead: the holder's
  // auto-sender writes whatever the session's current climb is, so making this
  // climb current lights it on their link. With nothing to relay we stop at
  // 'noop': the bulb already reads lit, so a tap that does nothing tells the
  // truth ("it's on, someone else is driving"). Taking the board on purpose is
  // the wall button's swipe (#7113 PR 4), which asks the crewmate's phone and
  // connects with this suppression lifted.
  if (args.holderIsAuthoritative) return args.canRelay ? 'relay' : 'noop';
  return 'connect';
}

/**
 * Board presence suggests a crewmate is driving the wall but hasn't confirmed
 * a holder yet: this phone joined a session (or bound the board) and its feed
 * names a climb a session member lit under an hour ago, with no holder event
 * since (#7017 QA). Presence inputs only, so one owner
 * (`CrewHolderSuspicionSync`) reads it once for the whole app and asks the
 * feed to confirm. Any holder event (`lastConnectionSeq > 0`: a live
 * `BoardConnectionChanged`, or a catch-up's holder refresh), named, anonymous
 * or free, ends it.
 */
export function deriveCrewHolderSuspected(args: {
  inSession: boolean;
  /** Presence's holder, if any; `userId` null for an anonymous one. */
  holder: { userId?: string | null } | null;
  /** Presence's latest holder event; 0 until a live event or a catch-up names one. */
  lastConnectionSeq: number;
  /** Who presence says lit the wall's climb. */
  wallSenderUserId: string | null;
  /** That climb was lit under an hour ago (`isPresenceFresh`). */
  wallPresenceFresh: boolean;
  sessionMemberUserIds: ReadonlySet<string>;
  /**
   * The signed-in climber (`useViewerUserId`). Their own climb, lit on this
   * phone before a relaunch or on another device, is never a crewmate's hold;
   * unknown is never read as somebody else.
   */
  viewerUserId: string | null;
}): boolean {
  if (!args.inSession || args.viewerUserId === null) return false;
  // A named holder is presence's answer: a crewmate's is authoritative, and
  // anyone else's (a stranger, this phone's stale hold) keeps today's rules.
  if (args.holder?.userId != null) return false;
  // Any holder event is presence's answer too, whatever it says.
  if (args.lastConnectionSeq > 0) return false;
  const sender = args.wallSenderUserId;
  if (sender === null || sender === args.viewerUserId || !args.wallPresenceFresh) return false;
  return args.sessionMemberUserIds.has(sender);
}

/**
 * This phone's bulb treats the board as the suspected crewmate's
 * ({@link deriveCrewHolderSuspected}): a tap relays or waits and never
 * connects. Without it an unknown holder read as a free board, and a
 * crewmate's Put on the wall both moved the crew's climb and opened the
 * Select Board picker that could take the board off the holder.
 *
 * A wrong `true` blocks a connect, so the owner releases the suspicion after
 * `CREW_HOLDER_CONFIRM_MS` without a confirmation, and this never applies to
 * this phone's own link or its own stale hold.
 */
export function deriveCrewHolderUnconfirmed(args: {
  /** The suspicion, after the owner's release. */
  suspected: boolean;
  localConnected: boolean;
  /** A session member holds the board per presence's holder (already a relay). */
  holderIsAuthoritative: boolean;
  wallSenderUserId: string | null;
  /** The account this phone last held the board as: its own stale hold, never a crewmate. */
  lastLocalHolderUserId: string | null;
}): boolean {
  if (!args.suspected || args.localConnected || args.holderIsAuthoritative) return false;
  return args.wallSenderUserId !== null && args.wallSenderUserId !== args.lastLocalHolderUserId;
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
 *
 * It also carries the peer signal for a BYSTANDER on a wall with no lights —
 * someone who never took the wall and is not in a party session. `boardConnection`
 * only reports a peer whose userId matches a session member, and production says
 * the sharing pattern here is *same board, no session*: 413 of 1,162 boards with
 * climb events have more than one distinct reporter, while only 36 have any
 * session row at all. Without this branch the climber watching someone else's
 * turn — the case the feature exists for — sees nothing.
 *
 * Restricted to `ledless` on purpose. On a wall WITH lights the holder can be a
 * stranger who happens to share the board feed, and `deriveBoardConnection`'s
 * session gate deliberately keeps them from lighting your bulb. A wall with no
 * light kit has no such ambiguity: the holder is by definition the person whose
 * climb is up, which is exactly what the gym screen already shows everyone.
 */
export function deriveInAppBoardConnection(args: {
  boardConnection: BoardConnection;
  ledless: boolean;
  wallHeld: boolean;
  wallHeldByOtherUser: boolean;
}): BoardConnection {
  if (args.wallHeld && args.wallHeldByOtherUser) return 'heldByPeer';
  if (args.wallHeld) return 'connectedByMe';
  if (args.ledless && args.wallHeldByOtherUser && args.boardConnection === 'disconnected') return 'heldByPeer';
  return args.boardConnection;
}
