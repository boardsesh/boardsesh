// The one geometry module the create-tick sheet (LogAscentSheet/QuickTickBar)
// and the edit-tick sheet (LogbookEditSheet) both import.
//
// The rule these constants exist to enforce: the ROW owns the horizontal
// gutter. A child rendered inside a tick row must not add horizontal padding of
// its own — that is what produced the ragged 72 / 88 / 98pt left edge down the
// old sheets, where every picker brought its own inset and no two controls
// lined up. Two vertical seams, no exceptions: labels start at TICK_GUTTER,
// every control starts at TICK_CONTROL_ORIGIN.
import { spacing } from '../../theme/tokens';
import { glassSize } from '../../theme/layout';

/** The single horizontal gutter for every tick row, header and destructive row. */
export const TICK_GUTTER = spacing[4]; // 16

/** Minimum width of a row's label column. Not a fixed width — a longer
 *  translation grows the column and pushes nothing out of alignment, because the
 *  control seam is derived from this floor, not from the rendered text. */
export const TICK_LABEL_MIN_WIDTH = 56;

/** Gap between a row's label column and its control slot. */
export const TICK_LABEL_GAP = spacing[3]; // 12

/** The control seam: where every picker starts, and where a row's separator is
 *  inset to. 16 + 56 + 12 = 84. */
export const TICK_CONTROL_ORIGIN = TICK_GUTTER + TICK_LABEL_MIN_WIDTH + TICK_LABEL_GAP; // 84

/** The row beat. Every plain field row is this tall. */
export const TICK_ROW_HEIGHT = 56;

/** Rows holding a horizontal chip rail: 44pt chip + 2x spacing[1] of rail
 *  padding, rounded to the 4pt grid. */
export const TICK_RAIL_ROW_HEIGHT = 60;

/** The angle row: a native slider needs more vertical room than a chip before
 *  its thumb crowds the hairlines above and below. */
export const TICK_ANGLE_ROW_HEIGHT = 64;

/** Sheet header (grade identity bar + title + meta + close disc). */
export const TICK_HEADER_HEIGHT = 56;

/** The pinned action row. Matches the app's hero action height so a tick CTA is
 *  the same object as every other defining action. */
export const TICK_ACTION_HEIGHT = glassSize.hero; // 56

/** Always-reserved height of the action bar's error slot. Reserved even when
 *  empty so a failed save prints its reason without moving the buttons under
 *  the climber's thumb. One `footnote` line. */
export const TICK_ERROR_SLOT_HEIGHT = 18;

/** Trailing inset on a bleeding rail row, so the last chip stops short of the
 *  screen edge and the rail reads as scrollable rather than clipped. */
export const TICK_RAIL_TRAIL_INSET = spacing[6]; // 24

/** Above this OS text scale a tick row stacks (label above control) instead of
 *  sharing a line. Below it the two-seam layout holds. */
export const TICK_STACK_FONT_SCALE = 1.3;

/** The tries rail always offers at least this many chips, so the common range
 *  is one tap even before the climber has entered a higher count. */
export const TICK_COUNT_RAIL_MIN_CHIPS = 15;

/**
 * Create sheet detents.
 *
 * Column: header 56 + rows (date 56 + grade 60 + stars 56 + tries 60 + note 56
 * = 288) + footer (paddingTop 12 + error slot 18 + gap 8 + button 56 +
 * paddingBottom 12 + window inset ~34 = 140) = 484; plus SHEET_TOP_CHROME_PT 20
 * = 504. On an iPhone 16 Pro the fraction base is 852 - 59 top inset - 24 top
 * gap = 769, so 504/769 = 65.5% -> '65%'. The second detent is the keyboard
 * detent.
 */
export const CREATE_TICK_SNAP_POINTS = ['65%', '92%'];

/**
 * Edit sheet detents.
 *
 * Column: header 56 + rows (status 56 + date 56 + grade 60 + angle 64 + stars
 * 56 + tries 60 + note 56 = 408) + delete group (spacing[8] 32 + 56 = 88) +
 * footer 122 = 674; plus 20 = 694/769 = 90%. That is higher than we want a
 * sheet to open, so the first detent is deliberately '80%' and the body scrolls
 * the last ~90pt — safe because Save is pinned in the footer, not chased down
 * the scroll. The second detent is the keyboard detent.
 */
export const EDIT_TICK_SNAP_POINTS = ['80%', '92%'];
