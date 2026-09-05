import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';

export type ViewOnlyPreviewNavigationTarget =
  | { viewOnly: false }
  | { viewOnly: true; targetItem: ClimbQueueItem | null };

export function getViewOnlyPreviewNavigationTarget({
  previewItem,
  previewSuggestionSource,
  targetItem,
  forceViewOnly = false,
}: {
  previewItem: ClimbQueueItem | null;
  previewSuggestionSource: PlaylistSuggestionSource | null;
  targetItem: ClimbQueueItem | null;
  /**
   * True when a local setting (lightOnSwipe off) says this navigation must
   * not commit/light the board — the same view-only landing as the
   * wrong-board path below, just a different reason, and independent of
   * `previewItem`/`previewSuggestionSource` (it applies on the very first
   * swipe away from a real committed climb, not just mid-preview-chain).
   */
  forceViewOnly?: boolean;
}): ViewOnlyPreviewNavigationTarget {
  if (forceViewOnly) return { viewOnly: true, targetItem };
  // Mobile only sets previewSuggestionSource for the wrong-board view-only
  // drawer path. Normal playlist activation commits navigation through the
  // queue and must leave this value null.
  if (!previewSuggestionSource || !previewItem) return { viewOnly: false };
  return { viewOnly: true, targetItem };
}

/**
 * The wiring `handlePrev`/`handleNext` actually call: turns the `lightOnSwipe`
 * setting and the shared-session browse latch into `forceViewOnly` and delegates
 * to {@link getViewOnlyPreviewNavigationTarget}. Split out as its own function
 * (rather than inlining the translation at each call site) so it is directly
 * unit-testable — the component itself has no render test (PlayDrawer's
 * dependency graph makes one impractical; see IpadPlayPane.test.tsx, which mocks
 * it out entirely).
 *
 * The two reasons to stay view-only are independent and either one is enough:
 * the climber turned board lighting off for swipes, or someone else is in the
 * session and a swipe would move THEIR wall and THEIR next-up.
 */
export function getSwipeNavigationTarget({
  previewItem,
  previewSuggestionSource,
  targetItem,
  lightOnSwipe,
  inSharedSession = false,
}: {
  previewItem: ClimbQueueItem | null;
  previewSuggestionSource: PlaylistSuggestionSource | null;
  targetItem: ClimbQueueItem | null;
  lightOnSwipe: boolean;
  /**
   * A browse latch is up because there is an audience: a party session with at
   * least one other climber in it, OR a latch that armed while there was one and
   * has not been exited yet (the latch is one-way — see PlayDrawer). Defaults to
   * false so the solo call sites read unchanged.
   */
  inSharedSession?: boolean;
}): ViewOnlyPreviewNavigationTarget {
  return getViewOnlyPreviewNavigationTarget({
    previewItem,
    previewSuggestionSource,
    targetItem,
    forceViewOnly: !lightOnSwipe || inSharedSession,
  });
}

/**
 * Whether a swipe from the drawer's current state would stay VIEW-ONLY — the
 * predicate the browse chrome is allowed to claim.
 *
 * The wall-state pill, the viewfinder brackets and the commit row all say some
 * version of "you're looking, the wall stays where it is". That sentence is only
 * true while navigation itself is view-only, and being in a preview is NOT
 * enough: with `lightOnSwipe` on and no suggestion source (the explicit "Preview"
 * climb action, a deep link, the workout builder), the very next swipe falls
 * through to `setCurrentClimb` — it writes the shared queue and re-arms the BLE
 * auto-sender. Chrome promising otherwise would be the exact wall-hijack the
 * feature exists to prevent.
 *
 * Derived from {@link getSwipeNavigationTarget} rather than re-stated, so the
 * chrome and the swipe can never drift apart. The target item is irrelevant to
 * the view-only decision, hence `null`.
 */
export function swipeStaysViewOnly({
  previewItem,
  previewSuggestionSource,
  lightOnSwipe,
  inSharedSession = false,
}: {
  previewItem: ClimbQueueItem | null;
  previewSuggestionSource: PlaylistSuggestionSource | null;
  lightOnSwipe: boolean;
  inSharedSession?: boolean;
}): boolean {
  return getSwipeNavigationTarget({
    previewItem,
    previewSuggestionSource,
    targetItem: null,
    lightOnSwipe,
    inSharedSession,
  }).viewOnly;
}

/**
 * What a tap on a Similar Climbs card does, by viewer.
 *
 * `'queue'` is the long-standing behaviour: add the climb to the queue (which
 * may raise the cross-board prompt) and make it the current climb.
 *
 * `'preview'` is the signed-out reader on the web export's read-only climb view.
 * Similar Climbs stays — it is a READ, and the best reason a visitor has to keep
 * looking — but its tap must not take the queue path, for two reasons that are
 * not about permissions:
 *
 *  - `addToQueue` writes the local queue, which for an anonymous reader is a
 *    list they cannot carry anywhere. Hidden queue button, live queue writes is
 *    the worst of both.
 *  - `setCurrentClimb` re-arms the BLE auto-sender, which pushes the new climb
 *    to a connected board. The anonymous view hides the lightbulb precisely so
 *    nothing here drives a wall; a similar-climb tap must not be the back door
 *    that does.
 *
 * The preview swap is the same mechanism `getViewOnlyPreviewNavigationTarget`
 * already uses above — show the climb, commit nothing.
 *
 * A member in a SHARED session takes the same preview path, for a third reason:
 * the member branch double-writes (`addToQueue` AND `setCurrentClimb`), so a tap
 * on a "you might also like" card would append to the crew's queue and take the
 * wall in one gesture — the loudest possible outcome for the most idle possible
 * intent. Browsing is what the tap means there; putting it up stays an explicit
 * act on the commit row.
 */
export function getSimilarClimbTapMode(
  viewer: 'member' | 'anonymous',
  { inSharedSession = false }: { inSharedSession?: boolean } = {},
): 'queue' | 'preview' {
  if (viewer === 'anonymous') return 'preview';
  return inSharedSession ? 'preview' : 'queue';
}
