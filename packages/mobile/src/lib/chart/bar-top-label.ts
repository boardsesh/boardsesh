/**
 * Layout maths for the label printed above a chart bar — the ascent count on
 * You -> Progress "Flash vs Redpoint" (#3779) and the grade on the play
 * drawer's "Community" ascents-by-angle chart (#4164). Pure geometry: what a
 * label may be broken into is the caller's business, passed in as `stackInto`.
 *
 * gifted-charts boxes a bar's top label in a container roughly one bar wide, so
 * on a phone — where seven or more bars squeeze each one down to about 13px — a
 * three-digit count ("128") wraps, and a both-formats grade ("V6 / 7A") spills
 * over its neighbours. These helpers decide how much room the label really
 * needs and, when the column can't hold it, stack it on two lines or stand it
 * on end so it reads vertically instead of being clipped.
 */
import { CHART_LABEL_LINE_HEIGHT, estimateLabelWidth } from './label-metrics';

/** Matches `styles.barTopLabel`: the gap between the label and the bar top. */
const BASE_LABEL_GAP = 2;

/** Widest count label in the chart, so every bar gets the same treatment. */
export function longestBarValue(values: readonly number[]): number {
  return values.reduce((widest, value) => (String(value).length > String(widest).length ? value : widest), 0);
}

export type BarTopLabelLayout = {
  /** Width of the absolutely-positioned label box gifted-charts renders. */
  width: number;
  /** Left offset that keeps a wider-than-bar box centred over its own bar. */
  left: number;
  /** The lines to draw — one entry, or the parts of a stacked label. */
  lines: string[];
  /** True when the label is rotated to read bottom-to-top. */
  rotated: boolean;
  /** Bottom margin that lifts the label clear of the bar it belongs to. */
  marginBottom: number;
  /** Extra vertical room the label needs above a plain one-line label. */
  headroom: number;
  /** Total height of the label box (gifted's `topLabelComponentHeight`). */
  height: number;
};

/**
 * Decide how to draw the label above a bar.
 *
 * - Fits on one line in the column: leave it alone (the pre-#3779 behaviour).
 *   That covers borrowing the gap beside the bar — the box widens and re-centres.
 * - Too wide, but `stackInto` breaks it into pieces that do fit: stack them,
 *   which costs a line of height and keeps the text upright.
 * - Still too wide: rotate it vertical, which costs height instead of width.
 *
 * `columnWidth` is the horizontal room a label may claim before it would collide
 * with the next label — one bar plus the gap to the bar beside it.
 *
 * `stackInto` is how the caller would break this label up if it had to — a
 * both-formats grade passes `splitGradeLabel(label)` (`["V6", "7A"]`), a plain
 * count passes nothing, because there is no sane place to split "128".
 */
export function computeBarTopLabelLayout(
  label: string,
  barWidth: number,
  columnWidth: number,
  fontScale = 1,
  stackInto: readonly string[] = [label],
): BarTopLabelLayout {
  const lineHeight = Math.ceil(CHART_LABEL_LINE_HEIGHT * fontScale);
  const textWidth = estimateLabelWidth(label, fontScale);

  if (textWidth <= columnWidth) {
    const width = Math.max(barWidth, Math.min(columnWidth, textWidth));
    return {
      width,
      left: Math.round((barWidth - width) / 2),
      lines: [label],
      rotated: false,
      marginBottom: BASE_LABEL_GAP,
      headroom: 0,
      height: lineHeight,
    };
  }

  // A "both formats" grade is two short labels wearing one long one — split it
  // back apart before resorting to rotation, which is slower to read.
  if (stackInto.length > 1) {
    const widestPart = stackInto.reduce((widest, part) => Math.max(widest, estimateLabelWidth(part, fontScale)), 0);
    if (widestPart <= columnWidth) {
      const width = Math.max(barWidth, Math.min(columnWidth, widestPart));
      const height = lineHeight * stackInto.length;
      return {
        width,
        left: Math.round((barWidth - width) / 2),
        lines: [...stackInto],
        rotated: false,
        marginBottom: BASE_LABEL_GAP,
        headroom: height - lineHeight,
        height,
      };
    }
  }

  return {
    width: textWidth,
    left: Math.round((barWidth - textWidth) / 2),
    lines: [label],
    rotated: true,
    // The rotation pivots on the label's centre, so half of it would swing down
    // over the bar. Push the whole box up by that half before it turns.
    marginBottom: Math.round((textWidth - lineHeight) / 2) + BASE_LABEL_GAP,
    headroom: Math.max(0, textWidth - lineHeight),
    height: textWidth,
  };
}
