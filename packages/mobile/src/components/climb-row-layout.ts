import { THUMBNAIL_WIDTH } from './climb-list-thumbnail-metrics';
import { spacing } from '../theme/tokens';

// The geometry of a climb row that depends on what the row shows. Pure, so every
// host of the row visual (the Climbs list, its skeleton, the queue, playlists, the
// workout preview) asks one function instead of repeating the arithmetic.

/**
 * The row's leading and trailing margin: 16pt, the HIG layout margin on iPhone
 * (HIG Layout) and the M3 list item's 16dp horizontal padding (M3 Lists). The
 * thumbnail lines up with section headers and every other list in the app.
 */
export const CLIMB_ROW_GUTTER = spacing[4];

/** The gap between the row's columns: thumbnail, text, grade. */
const CLIMB_ROW_COLUMN_GAP = spacing[3];

/**
 * Where a row's separator starts, so it sits under the text column: 104pt on a
 * plain row with a thumbnail (gutter + thumbnail + gap), the gutter alone
 * without one.
 *
 * `leadingInset` is where the row's first column starts, measured from the row's
 * leading edge. It defaults to the gutter. A host that puts a slot in front of
 * the thumbnail (the queue's position number, the playlist editor's remove
 * button) or pads tighter than the gutter passes its own figure.
 */
export function climbRowSeparatorInset(showThumbnail: boolean, leadingInset: number = CLIMB_ROW_GUTTER): number {
  return leadingInset + (showThumbnail ? THUMBNAIL_WIDTH + CLIMB_ROW_COLUMN_GAP : 0);
}
