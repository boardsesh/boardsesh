/**
 * Pure state resolvers for the play drawer's wall-state chrome: which state the
 * header pill shows, what the action bar's secondary row is, and whether a
 * commit has to ask before it takes the wall.
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
 * What the drawer header's leading slot says.
 *
 * - `'onWall'` — the displayed climb is the one lit on the board right now.
 * - `'live'`   — the next navigation drives the wall (or the shared queue).
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
};

/**
 * Strict ladder, first match wins.
 *
 * `onWall` deliberately outranks `browsing`: if you browse back onto the lit
 * climb the pill tells the truth about the wall while the commit bar keeps
 * carrying the latch. The pill is a statement about the wall, not about how you
 * got here.
 *
 * `live` needs stakes — a known lit climb, or a wall someone is actually driving
 * (this device's own BLE link, or a session member's). Plain solo with neither
 * returns `null`: there is nothing to promise, so the slot stays empty rather
 * than shipping a badge that means nothing.
 */
export function resolveWallPillState({
  isAnonymous,
  displayedClimbUuid,
  wallClimbUuid,
  browseLatchActive,
  navigationCommits,
  wallDriven,
}: WallPillStateInput): WallPillState {
  if (isAnonymous) return null;
  if (wallClimbUuid != null && displayedClimbUuid === wallClimbUuid) return 'onWall';
  if (browseLatchActive) return 'browsing';
  if (navigationCommits && (wallClimbUuid != null || wallDriven)) return 'live';
  return null;
}

/**
 * The same face never appears twice: while the pill renders the driver's avatar
 * (`onWall`), the lightbulb's holder pip is suppressed. This is the contract
 * PlayDrawer passes to `PlayDrawerActionBar` as `showHolderBadge`; it lives here
 * so the ⇔ is pinned by a test rather than by two components agreeing by hand.
 */
export function shouldShowHolderBadge(pillState: WallPillState): boolean {
  return pillState !== 'onWall';
}

/** What the action bar's secondary row is doing. */
export type CommitBarMode = 'actions' | 'commit';

/**
 * Which label the filled commit button wears. With no wall reachable at all —
 * nobody driving a wall and no known lit climb (the plain #4640 / logbook
 * preview) — it falls back to "Set active" so the button never promises a
 * lighting it cannot do.
 */
export type CommitButtonLabel = 'putOnWall' | 'setActive';

export type CommitBarModel = {
  mode: CommitBarMode;
  showBackToLive: boolean;
  showPutOnWall: boolean;
  showConfirm: boolean;
  commitLabel: CommitButtonLabel;
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
 * is already the lit one. `Back to live` stays: exiting the latch is still a
 * real action there.
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
}: CommitBarModelInput): CommitBarModel {
  const commitLabel: CommitButtonLabel = wallClimbUuid != null || wallDriven ? 'putOnWall' : 'setActive';
  const displayedIsCommittedHead = displayedClimbUuid != null && displayedClimbUuid === committedHeadUuid;
  const inCommitMode = previewPinned && !isAnonymous && !boardMismatch && !displayedIsCommittedHead;
  if (!inCommitMode) {
    return { mode: 'actions', showBackToLive: false, showPutOnWall: false, showConfirm: false, commitLabel };
  }
  const displayedIsWallClimb = wallClimbUuid != null && displayedClimbUuid === wallClimbUuid;
  // Browsing onto the busy wall's own climb resolves the conflict, so an armed
  // confirm has nothing left to ask — the pair snaps back to the browse buttons.
  const showConfirm = confirmArmed && !displayedIsWallClimb;
  return {
    mode: 'commit',
    showBackToLive: !showConfirm,
    showPutOnWall: !showConfirm && !displayedIsWallClimb,
    showConfirm,
    commitLabel,
  };
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
 * Consumed by the confirm swap in PR A2; the predicate lands now so the arming
 * rule is pinned before any UI depends on it.
 */
export function shouldArmBusyWallConfirm({
  wallClimbUuid,
  wallUuidAtLatchStart,
  displayedClimbUuid,
}: BusyWallConfirmInput): boolean {
  return wallClimbUuid != null && wallClimbUuid !== wallUuidAtLatchStart && wallClimbUuid !== displayedClimbUuid;
}

// The rest of the wall-state copy is read by WallStatePill / WallStateCallout /
// PlayDrawerCommitBar, so it needs no markers. These four have no reader until
// PR A2 lands the busy-wall confirm and the joined-browse notice; delete each
// marker as its `t()` call arrives, so the orphan gate stays honest about the
// keys that really have nobody reading them.
//
// i18n-keep session:playView.wallState.commitOverride.body
// i18n-keep session:playView.wallState.commitOverride.confirm
// i18n-keep session:playView.wallState.commitOverride.cancel
// i18n-keep session:playView.wallState.joinedBrowseNotice
