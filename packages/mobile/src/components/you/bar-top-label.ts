/**
 * Layout maths for the count printed above each bar of the You -> Progress
 * "Flash vs Redpoint" chart (#3779).
 *
 * gifted-charts boxes a bar's top label in a container that is exactly one bar
 * wide, so on a phone — where seven or more grade pairs squeeze each bar down
 * to roughly 13px — a three-digit count ("128") wraps or gets cut off. These
 * helpers decide how much room the count really needs and, when the column is
 * hopeless, stand the count on end so it reads vertically instead of being
 * clipped.
 */

/** The count renders at the `caption2` ramp: 11px on both UI variants. */
export const BAR_TOP_LABEL_FONT_SIZE = 11;
/** Tallest `caption2` line height across the two variants (Material's 16). */
export const BAR_TOP_LABEL_LINE_HEIGHT = 16;
/** Semibold digits measure ~0.62em wide in both SF and Roboto. */
const DIGIT_WIDTH_EM = 0.62;
/** A hair of breathing room on each side so glyphs never touch the box edge. */
const LABEL_SIDE_PADDING = 2;
/** Matches `styles.barTopLabel`: the gap between the count and the bar top. */
const BASE_LABEL_GAP = 2;

/** Widest count label in the chart, so every bar gets the same treatment. */
export function longestBarValue(values: readonly number[]): number {
  return values.reduce((widest, value) => (String(value).length > String(widest).length ? value : widest), 0);
}

/** Rendered width of a count label, in px, at the given accessibility font scale. */
export function estimateBarTopLabelWidth(value: number, fontScale = 1): number {
  const digits = String(Math.round(value)).length;
  return Math.ceil(digits * BAR_TOP_LABEL_FONT_SIZE * DIGIT_WIDTH_EM * fontScale) + LABEL_SIDE_PADDING * 2;
}

export type BarTopLabelLayout = {
  /** Width of the absolutely-positioned label box gifted-charts renders. */
  width: number;
  /** Left offset that keeps a wider-than-bar box centred over its own bar. */
  left: number;
  /** True when the count is rotated to read bottom-to-top. */
  rotated: boolean;
  /** Bottom margin that lifts the label clear of the bar it belongs to. */
  marginBottom: number;
  /** Extra vertical room a rotated label needs above the tallest bar. */
  headroom: number;
};

/**
 * Decide how to draw the count above a bar.
 *
 * - Fits inside the bar: leave it alone (the pre-#3779 behaviour).
 * - Fits if it borrows the gap to its neighbour: widen the box and re-centre it.
 * - Still too wide: rotate it vertical, which costs height instead of width.
 *
 * `columnWidth` is the horizontal room a label may claim before it would collide
 * with the next label — one bar plus the gap to the bar beside it.
 */
export function computeBarTopLabelLayout(
  longestValue: number,
  barWidth: number,
  columnWidth: number,
  fontScale = 1,
): BarTopLabelLayout {
  const textWidth = estimateBarTopLabelWidth(longestValue, fontScale);
  if (textWidth <= columnWidth) {
    const width = Math.max(barWidth, Math.min(columnWidth, textWidth));
    return {
      width,
      left: Math.round((barWidth - width) / 2),
      rotated: false,
      marginBottom: BASE_LABEL_GAP,
      headroom: 0,
    };
  }
  const lineHeight = Math.ceil(BAR_TOP_LABEL_LINE_HEIGHT * fontScale);
  return {
    width: textWidth,
    left: Math.round((barWidth - textWidth) / 2),
    rotated: true,
    // The rotation pivots on the label's centre, so half of it would swing down
    // over the bar. Push the whole box up by that half before it turns.
    marginBottom: Math.round((textWidth - lineHeight) / 2) + BASE_LABEL_GAP,
    headroom: Math.max(0, textWidth - lineHeight),
  };
}
