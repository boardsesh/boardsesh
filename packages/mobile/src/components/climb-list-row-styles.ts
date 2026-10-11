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
  // Separator inset to start at the text column (after the thumbnail).
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: climbRowSeparatorInset(true),
  },
  // Laid over `separator` on a row whose thumbnail is switched off: the text
  // column then starts at the gutter, and so does the line under it.
  separatorWithoutThumbnail: {
    marginLeft: climbRowSeparatorInset(false),
  },
});
