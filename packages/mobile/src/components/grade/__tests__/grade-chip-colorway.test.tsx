// @vitest-environment jsdom
//
// GradeChip paints from two palettes and the two must not bleed into each other.
// `grade` is the app-wide ramp every filter rail has always used — a selected V6
// is the same red it is everywhere else. `selection` is the tick sheets' palette,
// where the chip answers "which one did I pick?" in violet and amber and the
// grade ramp lives in the header instead.
//
// This test pins three things:
//   1. `grade` is byte-for-byte what it was before the tick redesign, for every
//      tone. The redesign added a colorway; it must not have moved the default.
//   2. `selection`'s selected tone is the brand fill with `onPrimary` text.
//   3. The box geometry does not move between tones. React Native is border-box,
//      so a tone that changes `borderWidth` resizes the content box under the
//      label — which is exactly what a 0pt selected border did.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type CapturedStyle = Record<string, unknown>;

const captured = vi.hoisted(() => ({
  frameStyles: [] as unknown[],
  textColors: [] as unknown[],
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  PlatformColor: (name: string) => name,
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({ children, style }: { children?: ReactNode; style?: unknown }) => {
    captured.frameStyles.push(style);
    return createElement('div', { 'data-chip-frame': 'true' }, children);
  },
}));

vi.mock('../../Text', () => ({
  Text: ({ children, color }: { children?: ReactNode; color?: unknown }) => {
    captured.textColors.push(color);
    return createElement('span', null, children);
  },
}));

vi.mock('../../../providers/theme-provider', async () => {
  const { makeThemeMock } = await import('../../../test/theme-mock');
  const theme = makeThemeMock();
  return { useTheme: () => theme };
});

import { GradeChip, type GradeChipColorway, type GradeChipTone } from '../GradeChip';
import { makeThemeMock } from '../../../test/theme-mock';
import { withAlpha } from '../../../theme/colors';
import { spacing } from '../../../theme/tokens';
import { readableTextColor } from '../grade-chip-colors';

const theme = makeThemeMock();
const { systemColors, brandColors } = theme;

/** A mid-ramp grade colour. Hex because `withAlpha` only speaks hex, and mid-ramp
 *  so `readableTextColor` has a real decision to make. */
const GRADE_COLOR = '#D64541';

/** Geometry constants mirrored from `GradeChip`'s stylesheet. Duplicated on
 *  purpose: the point is to catch a change to them, so reading them back from the
 *  component would defeat the assertion. */
const CHIP_MIN_WIDTH = 52;
const CHIP_PADDING_X = spacing[3];

type ChipPaint = {
  backgroundColor: unknown;
  borderColor: unknown;
  borderWidth: number;
  textColor: unknown;
};

function flatten(style: unknown): CapturedStyle {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  if (style && typeof style === 'object') return style as CapturedStyle;
  return {};
}

function paint(tone: GradeChipTone, colorway: GradeChipColorway): ChipPaint {
  captured.frameStyles = [];
  captured.textColors = [];
  render(
    createElement(GradeChip, {
      label: 'V6',
      tone,
      colorway,
      gradeColor: GRADE_COLOR,
      onPress: () => {},
      accessibilityLabel: 'V6',
    }),
  );
  const frame = flatten(captured.frameStyles.at(-1));
  return {
    backgroundColor: frame.backgroundColor,
    borderColor: frame.borderColor,
    borderWidth: frame.borderWidth as number,
    textColor: captured.textColors.at(-1),
  };
}

/**
 * The chip's laid-out width, the way React Native computes it: the border is
 * painted INSIDE the frame, so it is part of the box, and `minWidth` clamps the
 * whole box rather than the content. `labelWidth` stands in for the measured
 * glyph run.
 */
function outerBoxWidth(chip: ChipPaint, labelWidth: number): number {
  return Math.max(CHIP_MIN_WIDTH, labelWidth + CHIP_PADDING_X * 2 + chip.borderWidth * 2);
}

/** The room left for the label once both borders are subtracted. This is what
 *  moved when the selected tone dropped its border to 0. */
function contentBoxWidth(chip: ChipPaint, labelWidth: number): number {
  return outerBoxWidth(chip, labelWidth) - chip.borderWidth * 2;
}

beforeEach(() => {
  captured.frameStyles = [];
  captured.textColors = [];
});

describe('GradeChip colorway="grade"', () => {
  it('paints neutral as a flat fill with an invisible ring', () => {
    expect(paint('neutral', 'grade')).toEqual({
      backgroundColor: systemColors.fill,
      borderColor: 'transparent',
      borderWidth: 1,
      textColor: undefined,
    });
  });

  it('paints selected in the grade colour with readable text on it', () => {
    expect(paint('selected', 'grade')).toEqual({
      backgroundColor: GRADE_COLOR,
      borderColor: GRADE_COLOR,
      borderWidth: 1,
      textColor: readableTextColor(GRADE_COLOR),
    });
  });

  it('paints an in-range chip as a washed grade tint', () => {
    expect(paint('range', 'grade')).toEqual({
      backgroundColor: withAlpha(GRADE_COLOR, 0.18),
      borderColor: withAlpha(GRADE_COLOR, 0.75),
      borderWidth: 1,
      textColor: undefined,
    });
  });

  it('paints consensus fainter than in-range', () => {
    expect(paint('consensus', 'grade')).toEqual({
      backgroundColor: withAlpha(GRADE_COLOR, 0.11),
      borderColor: withAlpha(GRADE_COLOR, 0.55),
      borderWidth: 1,
      textColor: undefined,
    });
  });
});

describe('GradeChip colorway="selection"', () => {
  it('resolves the selected tone to the brand fill with onPrimary text', () => {
    const selected = paint('selected', 'selection');

    expect(selected.backgroundColor).toBe(brandColors.primaryFill);
    expect(selected.textColor).toBe(brandColors.onPrimary);
    // Never the grade ramp: the selection palette is the whole point of the colorway.
    expect(selected.backgroundColor).not.toBe(GRADE_COLOR);
  });

  it('marks the crowd consensus with an amber ring, not a fill', () => {
    const consensus = paint('consensus', 'selection');

    expect(consensus.backgroundColor).toBe(systemColors.fill);
    expect(consensus.borderColor).toBe(brandColors.warning);
    expect(consensus.textColor).toBe(systemColors.label);
  });

  it('leaves an untouched chip on plain chrome', () => {
    expect(paint('neutral', 'selection')).toEqual({
      backgroundColor: systemColors.fill,
      borderColor: 'transparent',
      borderWidth: 1,
      textColor: systemColors.label,
    });
  });
});

describe('GradeChip box geometry', () => {
  // Wide enough that `labelWidth + 2*CHIP_PADDING_X + 2*borderWidth` clears
  // CHIP_MIN_WIDTH. A short label (e.g. "V5" at ~20pt) is swallowed by the
  // min-width clamp, which makes every tone the same width no matter what the
  // border does — so a border regression would sail through unnoticed. These
  // assertions only mean something above the clamp.
  const LABEL_WIDTH = 40;
  const TONES: GradeChipTone[] = ['neutral', 'selected', 'consensus'];

  it('measures above the min-width clamp, or the rest of this block proves nothing', () => {
    for (const tone of TONES) {
      expect(outerBoxWidth(paint(tone, 'selection'), LABEL_WIDTH)).toBeGreaterThan(CHIP_MIN_WIDTH);
    }
  });

  it('lays the selected and neutral tones out to the same outer width', () => {
    // Consensus is deliberately excluded: its 2pt amber ring is meant to be seen,
    // so it is genuinely 2pt wider than its neighbours. That is a design choice,
    // not the drift this guards against.
    expect(outerBoxWidth(paint('selected', 'selection'), LABEL_WIDTH)).toBe(
      outerBoxWidth(paint('neutral', 'selection'), LABEL_WIDTH),
    );
  });

  it('gives the consensus tone exactly its 2pt ring and no more', () => {
    const consensus = outerBoxWidth(paint('consensus', 'selection'), LABEL_WIDTH);
    const neutral = outerBoxWidth(paint('neutral', 'selection'), LABEL_WIDTH);

    expect(consensus - neutral).toBe(2);
  });

  it('keeps the label box identical whether or not the chip is selected', () => {
    // The regression this guards: `selected` used to drop borderWidth to 0, which
    // handed the label 2pt more room than the neutral chip beside it and nudged
    // the glyph every time the selection moved.
    const neutral = paint('neutral', 'selection');
    const selected = paint('selected', 'selection');

    expect(selected.borderWidth).toBe(neutral.borderWidth);
    expect(contentBoxWidth(selected, LABEL_WIDTH)).toBe(contentBoxWidth(neutral, LABEL_WIDTH));
  });

  it('keeps the selected tone the same size in both colorways', () => {
    expect(outerBoxWidth(paint('selected', 'selection'), LABEL_WIDTH)).toBe(
      outerBoxWidth(paint('selected', 'grade'), LABEL_WIDTH),
    );
  });
});
