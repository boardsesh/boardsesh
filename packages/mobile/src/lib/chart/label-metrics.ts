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
// Punctuation and whitespace are much narrower than a digit. Charging them the
// full digit width matters: it puts a both-formats grade ("V6 / 7A", three of
// its seven characters narrow) ~15% over its real width, which would stack the
// label on bars wide enough to hold it on one line.
const NARROW_GLYPH_WIDTH_EM: Record<string, number> = { ' ': 0.28, '/': 0.32, '.': 0.28, ',': 0.28 };
/** A hair of breathing room on each side so glyphs never touch the box edge. */
const LABEL_SIDE_PADDING = 2;

/** Rendered width of a label, in px, at the given accessibility font scale. */
export function estimateLabelWidth(text: string, fontScale = 1): number {
  let ems = 0;
  for (const glyph of text) ems += NARROW_GLYPH_WIDTH_EM[glyph] ?? GLYPH_WIDTH_EM;
  return Math.ceil(ems * CHART_LABEL_FONT_SIZE * fontScale) + LABEL_SIDE_PADDING * 2;
}
