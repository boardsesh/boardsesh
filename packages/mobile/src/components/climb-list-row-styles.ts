import { StyleSheet } from 'react-native';
import { CLIMB_ROW_GUTTER, CLIMB_ROW_VERTICAL_PADDING, climbRowSeparatorInset } from './climb-row-layout';
import { spacing } from '../theme/tokens';

// The gutter is defined with the rest of the row's geometry; re-exported here
// because the hosts that pad a row to it already import the row styles.
export { CLIMB_ROW_GUTTER };

/**
 * Row layout shared by the climbs-list row (`ClimbListRow`) and the static climb
 * preview shown at the top of the actions / add-to-playlist sheets
 * (`ClimbPreviewCard`), so the preview renders byte-for-byte like a list row.
 * Colours (row background, separator) are applied inline by each consumer from
 * scheme-aware `systemColors` — only the layout lives here.
 */
export const climbListRowStyles = StyleSheet.create({
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: CLIMB_ROW_GUTTER,
    paddingVertical: CLIMB_ROW_VERTICAL_PADDING,
    gap: spacing[3],
  },
  // The hairline itself. Where it starts depends on the row's thumbnail, so the
  // inset comes from `climbRowSeparatorInsetStyle`.
  separator: {
    height: StyleSheet.hairlineWidth,
  },
});

// One style object per inset, made once: a style built during render would be a
// new object for every row on every render.
const separatorInsetStyles = new Map<number, { marginLeft: number }>();

/**
 * The separator's leading margin, so the line starts at the text column: after
 * the gutter, the thumbnail and the gap on a row with a thumbnail, at the gutter
 * on one without. `thumbnailWidth` is the row's cell (`useClimbListThumbnailSize`):
 * 76 in one column, 88 in a two-column Climbs list.
 */
export function climbRowSeparatorInsetStyle(hasThumbnail: boolean, thumbnailWidth: number): { marginLeft: number } {
  const marginLeft = climbRowSeparatorInset(hasThumbnail, CLIMB_ROW_GUTTER, thumbnailWidth);
  let style = separatorInsetStyles.get(marginLeft);
  if (!style) {
    style = { marginLeft };
    separatorInsetStyles.set(marginLeft, style);
  }
  return style;
}
