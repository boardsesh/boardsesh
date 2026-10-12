import { StyleSheet } from 'react-native';
import { spacing } from '../../theme/tokens';

/** The filter sheet body's side gutter. Rails bleed past it with a negative margin. */
export const FILTER_SHEET_GUTTER = spacing[4];

/**
 * The layout pieces a filter sheet places between the shared parts
 * (`FilterSheetSection`, `FilterLabelRow`, `FilterChip`...), so the climbs and
 * Logbook sheets space their controls the same way.
 */
export const filterSheetStyles = StyleSheet.create({
  // The scroll body's one column child.
  body: {
    paddingHorizontal: FILTER_SHEET_GUTTER,
  },
  // Between two controls inside one section.
  subsectionGap: {
    height: spacing[4],
  },
  // Breathing room between a footnote sub-label and a flush native
  // SegmentedControl (which, unlike the chip rows, has no intrinsic top padding).
  controlGap: {
    height: spacing[2],
  },
  // An "Any" chip followed by a StarRating.
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[4],
  },
  // Cancels the body's gutter so a horizontal rail scrolls out to the sheet's
  // edges; the rail's own insets put its first and last chip back on it.
  inlineRail: {
    marginTop: spacing[2],
    marginHorizontal: -FILTER_SHEET_GUTTER,
  },
});
