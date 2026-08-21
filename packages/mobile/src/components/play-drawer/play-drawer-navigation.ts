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
 */
export function getSimilarClimbTapMode(viewer: 'member' | 'anonymous'): 'queue' | 'preview' {
  return viewer === 'anonymous' ? 'preview' : 'queue';
}
