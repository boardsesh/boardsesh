import { describe, it, expect, vi } from 'vitest';

// Shared thumbnail metrics import theme tokens, which inspect Platform.OS.
// These arithmetic checks do not render native host components.
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import { textStyles, materialTextStyles } from '../../theme/typography';
import { THUMBNAIL_HEIGHT } from '../climb-list-thumbnail-metrics';
import { PROGRESS_MAX_FONT_SCALE } from '../../lib/climb-progress';

/**
 * The rich row's vertical budget, done as arithmetic rather than eyeballed.
 *
 * The 76×96 thumbnail supplies the baseline: stacked text under its height adds
 * no row height. Taller text makes the row grow because its containers have no
 * fixed height. Gaps and paddings do not scale with Dynamic Type; line heights
 * do when allowFontScaling is enabled.
 *
 * These measurements use the real type scales. They describe when extra row
 * height is needed; they do not replace device checks for wrapping or clipping.
 */

/** `styles.centerColumn.gap` in ClimbListItemContent. */
const CENTER_COLUMN_GAP = 2;

/** `ClimbPlaylistChips`: `styles.row.marginTop`, `styles.chip` padding + minHeight, CHIP_MAX_FONT_SCALE. */
const CHIP_ROW_MARGIN_TOP = 4; // spacing[1]
const CHIP_VERTICAL_PADDING = 2 * 2;
const CHIP_MIN_HEIGHT = 20;
const CHIP_MAX_FONT_SCALE = 1.3;

type Variant = 'liquidGlass' | 'material';

const scaleFor = (variant: Variant) => (variant === 'material' ? materialTextStyles : textStyles);

function lineHeight(variant: Variant, key: 'body' | 'footnote' | 'caption1', fontScale: number, cap: number): number {
  return scaleFor(variant)[key].lineHeight * Math.min(fontScale, cap);
}

/**
 * Height of the rich tier's centre column. `hasProgressLine` is the line this PR
 * adds; `hasPlaylistChips` is the base branch's tag strip, which only renders for
 * a climb that is actually in a playlist.
 */
function centreColumnHeight({
  variant,
  fontScale,
  hasProgressLine,
  hasPlaylistChips,
}: {
  variant: Variant;
  fontScale: number;
  hasProgressLine: boolean;
  hasPlaylistChips: boolean;
}): number {
  // `Text` itself caps every variant at 1.5 (maxFontSizeMultiplier).
  const nameHeight = lineHeight(variant, 'body', fontScale, 1.5);
  const subtitleHeight = lineHeight(variant, 'footnote', fontScale, 1.5);
  const progressHeight = hasProgressLine ? lineHeight(variant, 'footnote', fontScale, PROGRESS_MAX_FONT_SCALE) : 0;
  const chipHeight = hasPlaylistChips
    ? CHIP_ROW_MARGIN_TOP +
      Math.max(CHIP_MIN_HEIGHT, CHIP_VERTICAL_PADDING + lineHeight(variant, 'caption1', fontScale, CHIP_MAX_FONT_SCALE))
    : 0;

  const lines = 2 + (hasProgressLine ? 1 : 0) + (hasPlaylistChips ? 1 : 0);
  const gaps = (lines - 1) * CENTER_COLUMN_GAP;
  return nameHeight + progressHeight + subtitleHeight + gaps + chipHeight;
}

const round = (value: number) => Math.round(value * 10) / 10;

const VARIANTS: Variant[] = ['liquidGlass', 'material'];
const TIERS = [1, 1.15, 1.3, 1.5];

describe('rich row vertical budget', () => {
  it('uses the thumbnail height as the baseline', () => {
    expect(THUMBNAIL_HEIGHT).toBe(96);
  });

  it('fits name + progress + crowd line at every Dynamic Type tier', () => {
    for (const variant of VARIANTS) {
      for (const fontScale of TIERS) {
        const height = centreColumnHeight({ variant, fontScale, hasProgressLine: true, hasPlaylistChips: false });
        expect(
          height,
          `${variant} @ ${fontScale}× measures ${round(height)}pt against a ${THUMBNAIL_HEIGHT}pt budget`,
        ).toBeLessThanOrEqual(THUMBNAIL_HEIGHT);
      }
    }
  });

  it('measures the three-line rich row exactly', () => {
    const measure = (variant: Variant, fontScale: number) =>
      round(centreColumnHeight({ variant, fontScale, hasProgressLine: true, hasPlaylistChips: false }));
    // Liquid Glass (HIG): body 22 · footnote 18 · gap 2.
    expect(measure('liquidGlass', 1)).toBe(62);
    expect(measure('liquidGlass', 1.15)).toBe(70.7);
    expect(measure('liquidGlass', 1.3)).toBe(79.4);
    expect(measure('liquidGlass', 1.5)).toBe(87.4);
    // Material (M3): body 24 · footnote 16 · gap 2.
    expect(measure('material', 1)).toBe(60);
    expect(measure('material', 1.15)).toBe(68.4);
    expect(measure('material', 1.3)).toBe(76.8);
    expect(measure('material', 1.5)).toBe(84.8);
  });

  it('still fits with playlist tags at the default text size', () => {
    for (const variant of VARIANTS) {
      const height = centreColumnHeight({ variant, fontScale: 1, hasProgressLine: true, hasPlaylistChips: true });
      expect(height).toBeLessThanOrEqual(THUMBNAIL_HEIGHT);
    }
  });

  it('records the extra row height needed for four lines at larger text sizes', () => {
    // A climb with playlist chips and personal history stacks four lines.
    // At larger text sizes the content exceeds the thumbnail's baseline, so the
    // row must grow. This measurement alone does not imply clipping.
    const height = centreColumnHeight({
      variant: 'liquidGlass',
      fontScale: 1.15,
      hasProgressLine: true,
      hasPlaylistChips: true,
    });
    expect(round(height)).toBe(99.1);
    expect(height).toBeGreaterThan(THUMBNAIL_HEIGHT);
  });

  it('leaves the base branch (no progress line) untouched and inside budget', () => {
    for (const variant of VARIANTS) {
      for (const fontScale of TIERS) {
        const height = centreColumnHeight({ variant, fontScale, hasProgressLine: false, hasPlaylistChips: true });
        expect(height).toBeLessThanOrEqual(THUMBNAIL_HEIGHT);
      }
    }
  });
});
