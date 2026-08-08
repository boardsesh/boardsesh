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
 *
 * Rotation is right for a count, where every bar's number is its own fact. It
 * is NOT right for a row of grades, which repeat across neighbouring bars and
 * are better thinned out than turned sideways — see `grade-bar-labels.ts`.
 */
import { CHART_LABEL_LINE_HEIGHT, estimateLabelWidth } from './label-metrics';

/** Matches `styles.barTopLabel`: the gap between the label and the bar top. */
const BASE_LABEL_GAP = 2;

/**
 * Widest count label in the chart, so every bar gets the same treatment.
 * Seeded with the first value, not 0 — seeding with 0 handed back a count that
 * was never in the chart whenever every bar had a single digit.
 */
export function longestBarValue(values: readonly number[]): number {
  return values.reduce(
    (widest, value) => (String(value).length > String(widest).length ? value : widest),
    values[0] ?? 0,
  );
}

export type BarTopLabelLayout = {
  /** Width of the absolutely-positioned label box gifted-charts renders. */
  width: number;
  /** Left offset that keeps a wider-than-bar box centred over its own bar. */
  left: number;
  /** True when the label is rotated to read bottom-to-top. */
  rotated: boolean;
  /** Bottom margin that lifts the label clear of the bar it belongs to. */
  marginBottom: number;
  /** Extra vertical room the label needs above a plain one-line label. */
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
  label: string,
  barWidth: number,
  columnWidth: number,
  fontScale = 1,
): BarTopLabelLayout {
  const lineHeight = Math.ceil(CHART_LABEL_LINE_HEIGHT * fontScale);
  const textWidth = estimateLabelWidth(label, fontScale);

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
