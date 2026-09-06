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

/** How much of TICK_ACTION_HEIGHT is label rather than the native control's own
 *  padding. Only the label grows with the OS text scale — a SwiftUI/Compose
 *  button's padding is fixed — so a scaled action height adds the growth of this
 *  one line and nothing else.
 *
 *  Approximate, and deliberately one number for both platforms: an iOS `body`
 *  line is 17pt at the system 1.29 leading (~22) and a Compose `bodyLarge` line
 *  is 24sp, so Android under-grows by ~2dp per full step of scale. The button is
 *  exactly this tall either way; the slack is padding, not a clipped label. A
 *  per-platform constant would buy those 2dp at the cost of two numbers that can
 *  drift apart. */
export const TICK_ACTION_LABEL_HEIGHT = 22;

/**
 * The action row's button height at a given OS text scale.
 *
 * The row pins ONE height across both buttons because the tonal Attempt and the
 * filled Send are different native controls: each derives its own padding, so
 * left to measure themselves they land ~7pt apart and the row reads crooked.
 * The pin has to hold at every text scale — a button that only sometimes carries
 * a height would flip `Host`'s `matchContents` mid-life, and the axis it stops
 * measuring is the axis nothing else sizes.
 *
 * Never below TICK_ACTION_HEIGHT: that is the hero floor, not a measurement.
 */
export function tickActionHeight(fontScale: number): number {
  return Math.round(TICK_ACTION_HEIGHT + TICK_ACTION_LABEL_HEIGHT * (Math.max(1, fontScale) - 1));
}

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
 * Create sheet detents. iOS / web only — Android takes `@expo/ui`'s
 * content-fitting path (`androidContentSized` on `ModalSheet`, #4720) and never
 * reads these values.
 *
 * Column: header 56 + rows (date 56 + grade 60 + stars 56 + tries 60 + note 68
 * = 300) + footer (paddingTop 12 + error slot 18 + gap 8 + button 56 +
 * paddingBottom 12 + window inset ~34 = 140) = 496; plus SHEET_TOP_CHROME_PT 20
 * = 516. On an iPhone 16 Pro the fraction base is 852 - 59 top inset - 24 top
 * gap = 769, so 516/769 = 67.1%. The detent stays '65%' anyway — that is a
 * 480pt column, ~16pt short of the content, so the bottom edge of the note row
 * opens just under the fold. Deliberate: the body scrolls under a pinned
 * footer, and erring SHORT is the safe direction (use-sheet-column-style.ts:5-8
 * — a few spare points beat a clipped footer, #3330). The second detent is the
 * keyboard detent.
 *
 * The note row is 68, not the 56pt beat: the field's own minHeight 64 plus the
 * row's 4pt `alignTop` inset (#4642). Change either and this derivation moves.
 */
export const CREATE_TICK_SNAP_POINTS = ['65%', '92%'];

/**
 * Edit sheet detents. iOS / web only — Android takes the content-fitting path
 * (`androidContentSized`, #4720).
 *
 * Column: header 56 + rows (status 56 + date 56 + grade 60 + angle 64 + stars
 * 56 + tries 60 + note 68 = 420) + delete group (spacing[8] 32 + 56 = 88) +
 * footer 122 = 686; plus 20 = 706/769 = 91.8%. That is higher than we want a
 * sheet to open, so the first detent is deliberately '80%' (a 595pt column) and
 * the body scrolls the last ~91pt — safe because Save is pinned in the footer,
 * not chased down the scroll. The second detent is the keyboard detent.
 */
export const EDIT_TICK_SNAP_POINTS = ['80%', '92%'];
