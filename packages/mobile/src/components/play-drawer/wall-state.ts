/**
 * Pure state resolvers for the play drawer's wall-state chrome: what the wall
 * is doing (for the screen-reader announcements), whether the header shows the
 * back chip, what the browse latch commits, and whether a commit has to ask
 * before it takes the wall.
 *
 * Kept out of the components (like `play-drawer-layout.ts`) so every ladder is
 * table-testable without rendering PlayDrawer — its dependency graph makes a
 * render test impractical, which is exactly why the drawer's other decisions
 * (`play-drawer-navigation.ts`) live in pure modules too.
 *
 * Which climb the chrome names keys on DISPLAYED-EQUALS-WALL, never on who holds
 * the Bluetooth link: what the climber sees on screen versus what is physically
 * lit is the only thing the chrome is allowed to claim. Whether a wall is
 * REACHABLE at all is the separate `wallDriven` question — a promise about the
 * next swipe, and the one thing the link is allowed to answer.
 */

/**
 * What the wall is doing, as the climber's swipes see it. The header used to
 * draw all three as a chip; since #7000 it draws only the back chip
 * (`resolveHeaderPillState`) and the wall button says whether the climb is lit.
 * The states still drive the screen-reader announcements
 * (`resolveWallStateAnnouncement`).
 *
 * - `'onWall'` — the displayed climb is the one lit on the board right now.
 * - `'live'`   — a wall is being driven and the next navigation lights it.
 * - `'browsing'` — a browse latch is up: looking around, wall untouched.
 * - `null` — no wall stakes at all (plain solo, or the signed-out reader), so
 *   the slot stays empty exactly as it is today and the header's mirrored-flank
 *   centring is untouched in the overwhelmingly common state.
 */
export type WallPillState = 'onWall' | 'live' | 'browsing' | null;

export type WallPillStateInput = {
  /** The signed-out reader on the web export's read-only climb view. */
  isAnonymous: boolean;
  /** The climb the drawer is showing — the preview when one is up, else the queue head. */
  displayedClimbUuid: string | null;
  /** The climb physically lit on the board; `null` when no wall is known at all. */
  wallClimbUuid: string | null;
  /**
   * A browse latch is up: shared-session latch, long-press preview, the #4640
   * settings previews, or a playlist preview. In PR A1 this is today's
   * `isPreview` (`drawerPreviewItem != null`).
   */
  browseLatchActive: boolean;
  /** The next swipe writes the shared queue / lights the wall. */
  navigationCommits: boolean;
  /**
   * A wall is genuinely being driven: this device holds the Bluetooth link, or a
   * member of this session does. Fed from `useLightbulbControl().lit`, so the
   * pill and the lightbulb can never disagree about whether a wall is reachable.
   *
   * Deliberately NOT "a session exists". The Start button creates a session solo
   * (`use-session-commands.ts`), so keying on `sessionId != null` promised "your
   * next climb goes up on the wall" to a climber with nothing connected at all.
   */
  wallDriven: boolean;
  /**
   * The climb on screen is the climber's current climb and it is dark: the
   * #4979 hold kept it off, or "Turn off all lights" cleared it. The presence
   * feed can still name that climb as the wall's, so without this the pill
   * would say On the wall (or Live) over a dark board while the "Lit on the
   * wall" label is missing. Only the phone holding the link knows this, so a crew phone
   * can still read the climb as on the wall.
   */
  currentDark: boolean;
  /**
   * The climb on screen belongs to another board (a reachable one, or the
   * switch-board overlay would cover it): the connected wall refuses to light
   * it, so the pill can't claim it either.
   */
  otherBoard: boolean;
};

/**
 * Strict ladder, first match wins:
 *
 * 1. anonymous → `null`;
 * 2. displayed equals the climb presence names as lit → `onWall`, unless this
 *    phone knows it is dark (`currentDark`) or on another board (`otherBoard`),
 *    which is `null` (#7000);
 * 3. a browse latch is up → `browsing`, so the browse announcement still fires;
 * 4. the climb on screen is dark or on another board → `null`: neither On the
 *    wall nor Live may be claimed over it;
 * 5. the next swipe commits AND a wall is being driven → `live`;
 * 6. otherwise `null`.
 *
 * `onWall` deliberately outranks `browsing`: if you browse back onto the lit
 * climb the pill tells the truth about the wall while the commit bar keeps
 * carrying the latch. The pill is a statement about the wall, not about how you
 * got here.
 *
 * `live` needs a wall someone is actually driving (this device's own BLE link,
 * or a session member's). A known lit climb is not enough: with no link the
 * next swipe lights nothing, and the player would show Put on the wall
 * beside a Live pill. Plain solo returns `null`: there is nothing to
 * promise, so the slot stays empty rather than shipping a pill that means
 * nothing.
 *
 * Darkness isn't published through presence yet, so a crew phone can still read
 * a dark climb as on the wall.
 */
export function resolveWallPillState({
  isAnonymous,
  displayedClimbUuid,
  wallClimbUuid,
  browseLatchActive,
  navigationCommits,
  wallDriven,
  currentDark,
  otherBoard,
}: WallPillStateInput): WallPillState {
  if (isAnonymous) return null;
  // With no live link presence can name a climb lit hours ago (#7000), so the
  // pill never says On the wall from presence alone.
  const displayedCantBeLit = currentDark || otherBoard || !wallDriven;
  if (wallClimbUuid != null && displayedClimbUuid === wallClimbUuid) return displayedCantBeLit ? null : 'onWall';
  if (browseLatchActive) return 'browsing';
  if (displayedCantBeLit) return null;
  if (navigationCommits && wallDriven) return 'live';
  return null;
}

/**
 * The same face never appears twice: while the back chip renders the driver's
 * avatar (it goes back to the wall), the bulb's holder pip is suppressed. This
 * is the contract PlayDrawer passes to `PlayDrawerActionBar` as
 * `showHolderBadge`; it lives here so the ⇔ is pinned by a test rather than by
 * two components agreeing by hand.
 */
export function shouldShowHolderBadge(pill: HeaderPill): boolean {
  return pill?.backTarget !== 'wall';
}

export type HeaderPillInput = {
  /** A preview is pinned over the committed climb. */
  previewPinned: boolean;
  isAnonymous: boolean;
  displayedClimbUuid: string | null;
  /** The climber's own committed climb (the queue head), if any. */
  committedHeadUuid: string | null;
  /** The climb physically lit on the board, if any. */
  wallClimbUuid: string | null;
  /**
   * The iPad's persistent right-hand pane. It has no ⌄ to close, so going back
   * to an empty queue (its placeholder) is still somewhere to go.
   */
  isPane: boolean;
};

/**
 * The back chip, the header's one wall chip (#7000): `wall` when going back
 * lands on the climb that's lit (it shows the face of whoever lit it),
 * `current` when it lands on the climber's own climb and the wall shows
 * something else, or nothing.
 */
export type HeaderPill = { state: 'browsing'; backTarget: 'wall' | 'current' } | null;

/**
 * Whether going back from a pinned preview lands somewhere: off the committed
 * climb and onto one. With no committed climb only the iPad pane has somewhere
 * to go (its empty placeholder); the sheet would just empty, and ⌄ closes it.
 * The header's back chip and the explainer's Back to live share this rule.
 */
export function canLeavePreview({
  previewPinned,
  isAnonymous,
  displayedClimbUuid,
  committedHeadUuid,
  isPane,
}: Pick<
  HeaderPillInput,
  'previewPinned' | 'isAnonymous' | 'displayedClimbUuid' | 'committedHeadUuid' | 'isPane'
>): boolean {
  if (!previewPinned || isAnonymous) return false;
  return committedHeadUuid !== null ? displayedClimbUuid !== committedHeadUuid : isPane;
}

/**
 * The header chip as drawn: the back chip while a preview is pinned and going
 * back lands somewhere, off the committed climb and onto one (a crew that
 * hasn't lit anything, or a preview on an empty queue, has none, and going back
 * would empty the player; ⌄ closes instead).
 *
 * There is no On the wall or Live chip any more (#7000): the wall button says
 * whether the climb on screen is lit, and a second place saying it could
 * disagree. `resolveWallPillState` still names those states for the
 * screen-reader announcements.
 */
export function resolveHeaderPillState({
  previewPinned,
  isAnonymous,
  displayedClimbUuid,
  committedHeadUuid,
  wallClimbUuid,
  isPane,
}: HeaderPillInput): HeaderPill {
  if (!canLeavePreview({ previewPinned, isAnonymous, displayedClimbUuid, committedHeadUuid, isPane })) return null;
  const backToWall = wallClimbUuid !== null && wallClimbUuid === committedHeadUuid;
  return { state: 'browsing', backTarget: backToWall ? 'wall' : 'current' };
}

/**
 * The one-line caption on the top bar's second line while a climb is only
 * being looked at (#6667 panel, confusions 1 and 4; #6745 moved it off the
 * header's stats line):
 *
 * - `preview` — solo: "Preview, not lit". A tap with Light on tap off, or the
 *   Preview action, shows the climb without lighting it, and nothing else on
 *   screen said so.
 * - `crew` — "Only you see this", plus the climb the room has on the wall when
 *   one is lit, so a crewmate can tell a private look from taking the wall.
 * - `null` — nothing to say: the climb on screen is lit, or is the climber's
 *   own current climb, or (solo) no board is connected and nothing is lit, the
 *   same case the commit button falls back to Set active for.
 */
export type BrowseCaption = { kind: 'preview' } | { kind: 'crew'; wallClimbName: string | null } | null;

export type BrowseCaptionInput = {
  isAnonymous: boolean;
  /**
   * The header's climb is a preview: the pinned one, or (for a swipe peek) the
   * one a view-only swipe would open.
   */
  isPreview: boolean;
  climbUuid: string | null;
  /** The climber's own committed climb (the queue head), if any. */
  committedHeadUuid: string | null;
  /** The climb physically lit on the board, if any. */
  wallClimbUuid: string | null;
  wallClimbName: string | null;
  /** Someone else is in the session. */
  inCrew: boolean;
  /** A wall is genuinely being driven — see {@link WallPillStateInput.wallDriven}. */
  wallDriven: boolean;
};

export function resolveBrowseCaption({
  isAnonymous,
  isPreview,
  climbUuid,
  committedHeadUuid,
  wallClimbUuid,
  wallClimbName,
  inCrew,
  wallDriven,
}: BrowseCaptionInput): BrowseCaption {
  if (isAnonymous || !isPreview || climbUuid === null) return null;
  if (climbUuid === wallClimbUuid || climbUuid === committedHeadUuid) return null;
  if (inCrew) return { kind: 'crew', wallClimbName: wallClimbUuid !== null ? wallClimbName : null };
  return wallClimbUuid !== null || wallDriven ? { kind: 'preview' } : null;
}

/** What the action bar's secondary row is doing. */
export type CommitBarMode = 'actions' | 'commit';

/**
 * Which label the filled commit button wears. With no wall reachable at all —
 * nobody driving a wall, no known lit climb, and no board a tap could connect
 * to (the plain #4640 / logbook preview, a wall with no lights) — it falls back
 * to "Set active" so the button never promises a lighting it cannot do.
 */
export type CommitButtonLabel = 'putOnWall' | 'setActive';

export type CommitBarModel = {
  mode: CommitBarMode;
  showPutOnWall: boolean;
  showConfirm: boolean;
  commitLabel: CommitButtonLabel;
  /**
   * Put on the wall connects this phone after it sets the climb (#6939): no
   * wall is driven, and a tap on the bulb would connect to a board with lights.
   * The connect lights the climb the commit just made current.
   */
  connectsOnCommit: boolean;
};

export type CommitBarModelInput = {
  /**
   * A preview is pinned (`drawerPreviewItem != null`) — deliberately WIDER than
   * the browse latch. A long-press "Preview" with `lightOnSwipe` on has
   * committing swipes (so no browsing chrome), but the pinned climb still needs
   * its activation button: today's banner offered "Set active" there, and losing
   * it would strand the explicit Preview action with no way to promote.
   */
  previewPinned: boolean;
  isAnonymous: boolean;
  /** The displayed climb is on a board the climber isn't on. */
  boardMismatch: boolean;
  displayedClimbUuid: string | null;
  /** The climber's own queue head — what "Back to live" returns them to. */
  committedHeadUuid: string | null;
  wallClimbUuid: string | null;
  /** A busy-wall confirm has been armed by a first commit tap (PR A2). */
  confirmArmed: boolean;
  /** A wall is genuinely being driven — see {@link WallPillStateInput.wallDriven}. */
  wallDriven: boolean;
  /**
   * A tap on the bulb would connect this phone (`pressAction === 'connect'`):
   * a board is selected, it has lights, nothing is in flight and no session
   * peer holds it.
   */
  tapConnects: boolean;
};

/**
 * What the secondary row renders while a preview is pinned. The commit
 * affordance keys on the PINNED PREVIEW, not the browse latch: the latch decides
 * what the chrome may claim about swipes, but any pinned climb needs its
 * activation button (the old banner's "Set active" contract).
 *
 * Three ways the row stays on the normal actions:
 *  - anonymous — the read-only viewer has no queue to commit into;
 *  - `boardMismatch` — the switch-board overlay scrims this region and makes its
 *    own `accessibilityViewIsModal` claim, so commit controls under it would be
 *    dead controls. The wrong-board exits are the overlay's own Switch board,
 *    dismissing the drawer, and Back to live from the header pill's callout
 *    (which sits outside the scrimmed region);
 *  - the displayed climb IS the climber's own committed head — there is nothing
 *    to commit, so the bar collapses back on its own.
 *
 * `Put on the wall` hides (never renders disabled-dead) when the displayed climb
 * is already the lit one. Going back is not this row's job: the header's back
 * chip does it (`resolveHeaderPillState`).
 *
 * On the climber's own climb there is nothing to commit: the wall button's
 * Connect board, or its tap on a dark climb, lights it (#7000).
 */
export function resolveCommitBarModel({
  previewPinned,
  isAnonymous,
  boardMismatch,
  displayedClimbUuid,
  committedHeadUuid,
  wallClimbUuid,
  confirmArmed,
  wallDriven,
  tapConnects,
}: CommitBarModelInput): CommitBarModel {
  const connectsOnCommit = tapConnects && !wallDriven && !isAnonymous && !boardMismatch;
  const commitLabel: CommitButtonLabel =
    wallClimbUuid != null || wallDriven || connectsOnCommit ? 'putOnWall' : 'setActive';
  const displayedIsCommittedHead = displayedClimbUuid != null && displayedClimbUuid === committedHeadUuid;
  // With no link, presence can name a climb lit hours ago and nobody can see
  // the LEDs (#7000), so a tap that connects never counts it as already lit.
  const displayedIsWallClimb = wallClimbUuid != null && displayedClimbUuid === wallClimbUuid && !connectsOnCommit;
  const inCommitMode = previewPinned && !isAnonymous && !boardMismatch && !displayedIsCommittedHead;
  if (!inCommitMode) {
    return { mode: 'actions', showPutOnWall: false, showConfirm: false, commitLabel, connectsOnCommit: false };
  }
  // Browsing onto the busy wall's own climb resolves the conflict, so an armed
  // confirm has nothing left to ask — the pair snaps back to the browse buttons.
  const showConfirm = confirmArmed && !displayedIsWallClimb;
  return {
    mode: 'commit',
    showPutOnWall: !showConfirm && !displayedIsWallClimb,
    showConfirm,
    commitLabel,
    connectsOnCommit,
  };
}

/**
 * Which commit control the player draws: the busy-wall question, or Put on the
 * wall (one of the wall button's states) for a preview or a crew browse. A
 * preview still commits during a timed block: Put on the wall takes the row
 * from Fell / Sent until the climb is up.
 */
export function resolveCommitButton(model: CommitBarModel): 'putOnWall' | 'confirm' | null {
  if (model.showConfirm) return 'confirm';
  return model.mode === 'commit' && model.showPutOnWall ? 'putOnWall' : null;
}

/** How a browse latch ended — recorded by the handler that ended it. */
export type WallLatchExit = 'commit' | 'backToLive';

/** Which sentence a wall-state transition earns, or `null` for the ones that earn none. */
export type WallStateAnnouncement = 'browse' | 'committed' | 'backToLive' | null;

export type WallStateAnnouncementInput = {
  /** The pill state at the previous settled render; `undefined` on the first. */
  previous: WallPillState | undefined;
  next: WallPillState;
  /** The exit the climber just triggered, if this transition is one. */
  exit: WallLatchExit | null;
};

/**
 * What assistive tech is told when the wall state changes.
 *
 * Keyed on the TRANSITION, not on the state landed in, for two reasons neither
 * the pill nor the new state can supply on its own: the two sentences that end a
 * browse latch ("Back to live: X" / "X is on the wall") land on the SAME states,
 * so only the action taken tells them apart; and the commonest landing is no
 * pill at all (a plain preview with no BLE link and no session resolves to
 * `null`), which is why {@link useWallStateAnnouncer} runs in the host rather
 * than inside a component that unmounts with the transition it has to speak.
 */
export function resolveWallStateAnnouncement({
  previous,
  next,
  exit,
}: WallStateAnnouncementInput): WallStateAnnouncement {
  // Mount is not a transition: opening the drawer must never narrate a state the
  // climber navigated into deliberately.
  if (previous === undefined || previous === next) return null;
  if (next === 'browsing') return 'browse';
  if (previous !== 'browsing') return null;
  if (exit === 'commit') return 'committed';
  if (exit === 'backToLive') return 'backToLive';
  // The latch ended for some other reason (an angle change re-deriving the
  // drawer, say). Nothing was claimed, so nothing is claimed back.
  return null;
}

export type BusyWallConfirmInput = {
  /** The climb lit on the board right now. */
  wallClimbUuid: string | null;
  /** What was lit when the browse latch went up — the snapshot taken on latch start. */
  wallUuidAtLatchStart: string | null;
  displayedClimbUuid: string | null;
};

/**
 * Whether the first `Put on the wall` tap has to ask before it takes the wall.
 *
 * Someone else moved the wall while you were browsing, and they moved it to
 * something other than what you are about to put up — taking it silently would
 * blank a climb another climber is mid-attempt on. All three clauses are
 * load-bearing:
 *  - a dark wall (`null`) is nobody's, so committing to it never asks;
 *  - a wall that still shows what it showed when you started browsing is yours
 *    to take — nothing happened while you were away;
 *  - a wall that already shows YOUR climb needs no confirm; the commit is a
 *    no-op against the LEDs.
 *
 * Once armed, only three things stand the question down (no timer among them):
 * "Keep theirs", browsing on to another climb, or the conflict resolving itself
 * — which is this predicate going false, so the same rule reads both ways.
 */
export function shouldArmBusyWallConfirm({
  wallClimbUuid,
  wallUuidAtLatchStart,
  displayedClimbUuid,
}: BusyWallConfirmInput): boolean {
  return wallClimbUuid != null && wallClimbUuid !== wallUuidAtLatchStart && wallClimbUuid !== displayedClimbUuid;
}

/**
 * How much older than the latch's start a lighting must look before it counts as
 * "this was already up". Generous on purpose: the two clocks being compared are
 * different machines (the wall's timestamp is server-stamped, the latch's is this
 * phone's), and the safe direction is asking a question nobody needed rather than
 * taking a wall silently. A phone would have to run more than a minute FAST
 * before a peer's fresh lighting could read as pre-existing.
 */
export const WALL_READ_PRE_LATCH_TOLERANCE_MS = 60_000;

export type LateWallReadInput = {
  /** The snapshot taken on the latch's rising edge — `null` when the wall was unknown. */
  wallUuidAtLatchStart: string | null;
  /** What the wall reads now. */
  wallClimbUuid: string | null;
  /** The lit climb's server-stamped timestamp (ISO 8601), if any. */
  wallClimbSentAt: string | null;
  /** When browsing began, by this device's clock. `null` before any latch. */
  latchStartedAt: number | null;
};

/**
 * Whether a wall read that arrived AFTER browsing began is really the wall as it
 * was when browsing began.
 *
 * The snapshot is taken on the latch's rising edge, and at a cold start (or a
 * presence reconnect) the feed may not have delivered yet — so the snapshot says
 * `null`, which is indistinguishable from a dark wall. A second later the climb
 * that had been lit the whole time arrives, and without this the first "Put on
 * the wall" tap would announce "Someone just lit X" about a climb nobody touched.
 *
 * The discriminator is the lighting's own server timestamp: a climb lit well
 * before this browse started was not lit during it. Everything ambiguous — no
 * timestamp, an unparseable one, or one inside the skew tolerance — keeps the
 * protective behaviour and lets the confirm arm.
 */
export function shouldAdoptLateWallRead({
  wallUuidAtLatchStart,
  wallClimbUuid,
  wallClimbSentAt,
  latchStartedAt,
}: LateWallReadInput): boolean {
  // Only the unknown-wall case is in doubt: a snapshot that read a real climb
  // (or a real dark wall this device watched go dark) needs no help.
  if (wallUuidAtLatchStart !== null) return false;
  if (wallClimbUuid === null || wallClimbSentAt === null || latchStartedAt === null) return false;
  const sentAtMs = Date.parse(wallClimbSentAt);
  if (Number.isNaN(sentAtMs)) return false;
  // Anything lit during this browse — including a lighting stamped later than the
  // latch by a phone running slow — fails this and arms the confirm.
  return sentAtMs < latchStartedAt - WALL_READ_PRE_LATCH_TOLERANCE_MS;
}

// Every wall-state key now has a real `t()` call behind it — the pill, the
// callout, and the commit bar's browse and confirm modes — so this file no
// longer reserves any. It ended PR A1 reserving three (the `commitOverride.*`
// trio the confirm had no reader for yet) and each reservation came out with its
// reader, so the orphan gate stays honest about the keys nobody is reading.
