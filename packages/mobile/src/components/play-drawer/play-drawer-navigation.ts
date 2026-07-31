import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';

export type DrawerSwipeDirection = 'next' | 'prev';

/**
 * Returns a direction only while the swipe has a real horizontal sign. At rest
 * and after the post-commit reset, callers retain the last non-zero direction
 * instead of spuriously treating zero as "prev" and flipping the header peek.
 */
export function swipeDirectionForOffset(offset: number): DrawerSwipeDirection | null {
  'worklet';
  if (offset === 0) return null;
  return offset < 0 ? 'next' : 'prev';
}

export type ViewOnlyPreviewNavigationTarget =
  | { viewOnly: false }
  | { viewOnly: true; targetItem: ClimbQueueItem | null };

export function getViewOnlyPreviewNavigationTarget({
  previewItem,
  previewSuggestionSource,
  targetItem,
}: {
  previewItem: ClimbQueueItem | null;
  previewSuggestionSource: PlaylistSuggestionSource | null;
  targetItem: ClimbQueueItem | null;
}): ViewOnlyPreviewNavigationTarget {
  // Mobile only sets previewSuggestionSource for the wrong-board view-only
  // drawer path. Normal playlist activation commits navigation through the
  // queue and must leave this value null.
  if (!previewSuggestionSource || !previewItem) return { viewOnly: false };
  return { viewOnly: true, targetItem };
}
