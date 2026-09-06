import { StyleSheet } from 'react-native';
import { THUMBNAIL_WIDTH } from './ClimbListThumbnail';
import { separatorInsetForDensity } from './climb-list-thumbnail-metrics';
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
export const climbListRowStyles = StyleSheet.create({
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[2],
    gap: spacing[3],
  },
  // Separator inset to start at the text column (after the thumbnail).
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: THUMBNAIL_WIDTH + spacing[2] + spacing[3],
  },
  // Same separator against the compact tier's narrower thumbnail. Derived from the
  // metrics module, not a second hardcoded number, so the inset can't drift from
  // the cell it's supposed to line up with.
  compactSeparator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: separatorInsetForDensity('compact'),
  },
});
