/**
 * How much room a chart label takes, without a renderer.
 *
 * Chart layout has to be decided before React Native can measure anything: how
 * wide a y-axis gutter to reserve, whether a bar's grade fits above it. Every
 * axis and bar label in the app renders at the same 11px `caption2` ramp, so a
 * per-character estimate is close enough to make those calls and keeps the
 * maths unit-testable.
 */

/** Chart labels render at the `caption2` ramp: 11px on both UI variants. */
export const CHART_LABEL_FONT_SIZE = 11;
/** Tallest `caption2` line height across the two variants (Material's 16). */
export const CHART_LABEL_LINE_HEIGHT = 16;
/** Semibold digits and caps measure ~0.62em wide in both SF and Roboto. */
const GLYPH_WIDTH_EM = 0.62;
/** A hair of breathing room on each side so glyphs never touch the box edge. */
const LABEL_SIDE_PADDING = 2;

/** Rendered width of a label, in px, at the given accessibility font scale. */
export function estimateLabelWidth(text: string, fontScale = 1): number {
  return Math.ceil(text.length * CHART_LABEL_FONT_SIZE * GLYPH_WIDTH_EM * fontScale) + LABEL_SIDE_PADDING * 2;
}
