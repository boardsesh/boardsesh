/**
 * Pure layout math for the "Climb added to queue" snackbar's bottom offset.
 * Extracted from QueueAddedSnackbar so the (small but easy-to-break) positioning
 * rule is unit-testable: the pill floats one `gap` above the tab bar, and a
 * further `barContentHeight + gap` higher when the persistent queue bar is
 * showing so it never overlaps the bar.
 */
export function queueSnackbarBottomOffset(params: {
  /** Safe-area bottom inset. */
  insetsBottom: number;
  /** Height of the tab bar the snackbar floats above. */
  tabBarHeight: number;
  /** Height of the persistent queue bar (only added when it's visible). */
  barContentHeight: number;
  /** Spacing unit used both above the tab bar and above the queue bar. */
  gap: number;
  /** Whether the persistent queue bar is currently showing. */
  barVisible: boolean;
}): number {
  const { insetsBottom, tabBarHeight, barContentHeight, gap, barVisible } = params;
  return insetsBottom + tabBarHeight + (barVisible ? barContentHeight + gap : 0) + gap;
}
