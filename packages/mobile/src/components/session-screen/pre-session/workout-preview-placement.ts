/**
 * Where the pre-session workout preview (summary, stage headings and planned
 * climbs) goes. `inline` is the stacked layout every device has had: the
 * preview under the block cards in one list. `pane` moves it into the phone
 * split's leading pane (iPhone Duo open in landscape), in place of the board,
 * while the block cards and Start stay in the right column. `none` is a session
 * with no workout blocks, which has no preview.
 *
 * Pure, so the switch unit-tests without a device.
 */
export type WorkoutPreviewPlacement = 'none' | 'inline' | 'pane';

export function resolveWorkoutPreviewPlacement({
  hasWorkoutBlocks,
  phoneSplit,
  hasPaneSlot,
  isFocused,
}: {
  /** The workout has at least one block. */
  hasWorkoutBlocks: boolean;
  /** The phone split is on screen (`usePhoneSplit`). */
  phoneSplit: boolean;
  /** The screen sits in a tab host with a split pane (`useHasPhoneSplitPaneSlot`). */
  hasPaneSlot: boolean;
  /** The Session screen is the one on screen, not covered by another. */
  isFocused: boolean;
}): WorkoutPreviewPlacement {
  if (!hasWorkoutBlocks) return 'none';
  return phoneSplit && hasPaneSlot && isFocused ? 'pane' : 'inline';
}
