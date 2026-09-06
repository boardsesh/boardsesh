import { StyleSheet } from 'react-native';
import { THUMBNAIL_WIDTH, separatorInsetForDensity } from "./climb-list-thumbnail-metrics";
import { spacing } from '../theme/tokens';

/**
 * Row layout shared by the climbs-list row (`ClimbListRow`) and the static climb
 * preview shown at the top of the actions / add-to-playlist sheets
 * (`ClimbPreviewCard`), so the preview renders byte-for-byte like a list row.
 * Colours (row background, separator) are applied inline by each consumer from
 * scheme-aware `systemColors` — only the layout lives here.
 *
 * The EXISTING values are frozen: the preview card's whole reason to import this
 * is that it matches a `default`-density list row exactly. The climbs-list density
 * tiers therefore add styles ALONGSIDE (`compactSeparator`) rather than changing
 * anything here. `contentRow` itself needs no tier variant — every tier keeps the
 * same 8pt padding and 12pt gap, and only the thumbnail's height moves the row.
 */
/**
 * The row's leading and trailing margin: 16pt, the HIG layout margin on iPhone
 * (HIG Layout) and the M3 list item's 16dp horizontal padding (M3 Lists). The
 * thumbnail lines up with section headers and every other list in the app.
 */
export const CLIMB_ROW_GUTTER = spacing[4];

export const climbListRowStyles = StyleSheet.create({
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: CLIMB_ROW_GUTTER,
    paddingVertical: spacing[2],
    gap: spacing[3],
  },
  // Separator inset to start at the text column (after the thumbnail).
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: THUMBNAIL_WIDTH + CLIMB_ROW_GUTTER + spacing[3],
  },
  // Same separator against the compact tier's narrower thumbnail. Derived from the
  // metrics module, not a second hardcoded number, so the inset can't drift from
  // the cell it's supposed to line up with.
  compactSeparator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: separatorInsetForDensity('compact'),
  },
});
