// @vitest-environment jsdom
//
// GradeChip paints from two palettes and the two must not bleed into each other.
// `grade` is the filter rails' palette: the grade's colour is a dot at rest and
// the whole chip once selected, and a checkmark marks every chip that is part of
// the selection. `selection` is the tick sheets' palette, where the chip answers
// "which one did I pick?" in violet and amber and the grade ramp lives in the
// header instead.
//
// This test pins four things:
//   1. `grade` state is never colour alone: a dot at rest, a checkmark in range
//      and on the solid selected chip, and no tint on an in-range chip.
//   2. `selection` is untouched by the mark: no dot, no checkmark, same paint.
//   3. `selection`'s selected tone is the brand fill with `onPrimary` text.
//   4. The box geometry does not move between tones. React Native is border-box,
//      so a tone that changes `borderWidth` resizes the content box under the
//      label — which is exactly what a 0pt selected border did. In `grade` the
//      mark's slot is one size in every tone for the same reason.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type CapturedStyle = Record<string, unknown>;
type CapturedIcon = { name: string; color: unknown; size: number; maxFontSizeMultiplier: unknown };

const captured = vi.hoisted(() => ({
  frameStyles: [] as unknown[],
  textColors: [] as unknown[],
  viewStyles: [] as unknown[],
  icons: [] as unknown[],
  fontScale: 1,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ fontScale: captured.fontScale }),
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) => {
    captured.viewStyles.push(style);
    return createElement('div', null, children);
  },
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

vi.mock('../../Icon', () => ({
  Icon: (props: CapturedIcon) => {
    captured.icons.push(props);
    return createElement('span', { 'data-icon': props.name });
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
const MARK_SLOT_SIZE = 12;
const MARK_DOT_SIZE = 8;
const MARK_GAP = spacing[1];

type ChipPaint = {
  backgroundColor: unknown;
  borderColor: unknown;
  borderWidth: number;
  textColor: unknown;
};

/** What sits in front of the label: the grade dot, the checkmark, or neither. */
type ChipMark = {
  /** The slot both marks share, or undefined when the chip draws no mark at all. */
  slotSize: number | undefined;
  dot: { size: unknown; color: unknown; ringColor: unknown; ringWidth: unknown } | undefined;
  check: { color: unknown; size: number } | undefined;
};

function flatten(style: unknown): CapturedStyle {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  if (style && typeof style === 'object') return style as CapturedStyle;
  return {};
}

/** `null` renders the chip with no grade colour at all, as the range rail's "Any" does. */
function renderChip(tone: GradeChipTone, colorway: GradeChipColorway, gradeColor: string | null = GRADE_COLOR) {
  captured.frameStyles = [];
  captured.textColors = [];
  captured.viewStyles = [];
  captured.icons = [];
  render(
    createElement(GradeChip, {
      label: 'V6',
      tone,
      colorway,
      gradeColor: gradeColor ?? undefined,
      onPress: () => {},
      accessibilityLabel: 'V6',
    }),
  );
}

function paint(tone: GradeChipTone, colorway: GradeChipColorway): ChipPaint {
  renderChip(tone, colorway);
  const frame = flatten(captured.frameStyles.at(-1));
  return {
    backgroundColor: frame.backgroundColor,
    borderColor: frame.borderColor,
    borderWidth: frame.borderWidth as number,
    textColor: captured.textColors.at(-1),
  };
}

/** The label row's own style: the first view the chip renders, ahead of the mark's. */
function contentStyle(): CapturedStyle {
  return flatten(captured.viewStyles[0]);
}

function mark(tone: GradeChipTone, colorway: GradeChipColorway, gradeColor: string | null = GRADE_COLOR): ChipMark {
  renderChip(tone, colorway, gradeColor);
  const views = captured.viewStyles.map(flatten);
  // The dot is the one view that paints a colour; the slot is the one sized
  // view that paints none.
  const dotStyle = views.find((style) => style.backgroundColor !== undefined);
  const slotStyle = views.find((style) => style.width !== undefined && style.backgroundColor === undefined);
  const icon = captured.icons.at(-1) as CapturedIcon | undefined;
  return {
    slotSize: slotStyle?.width as number | undefined,
    dot: dotStyle
      ? {
          size: dotStyle.width,
          color: dotStyle.backgroundColor,
          ringColor: dotStyle.borderColor,
          ringWidth: dotStyle.borderWidth,
        }
      : undefined,
    check: icon?.name === 'check.small' ? { color: icon.color, size: icon.size } : undefined,
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
  captured.viewStyles = [];
  captured.icons = [];
  captured.fontScale = 1;
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

  it('carries the grade colour of a neutral chip as an 8pt dot in a separator ring', () => {
    expect(mark('neutral', 'grade')).toEqual({
      slotSize: MARK_SLOT_SIZE,
      dot: { size: MARK_DOT_SIZE, color: GRADE_COLOR, ringColor: systemColors.separator, ringWidth: 1 },
      check: undefined,
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

  it('marks a selected chip with a checkmark in the label colour, not the dot', () => {
    expect(mark('selected', 'grade')).toEqual({
      slotSize: MARK_SLOT_SIZE,
      dot: undefined,
      check: { color: readableTextColor(GRADE_COLOR), size: MARK_SLOT_SIZE },
    });
  });

  it('paints an in-range chip exactly like a neutral one: no tint, no coloured ring', () => {
    expect(paint('range', 'grade')).toEqual(paint('neutral', 'grade'));
  });

  it('marks an in-range chip with a checkmark in place of the dot', () => {
    expect(mark('range', 'grade')).toEqual({
      slotSize: MARK_SLOT_SIZE,
      dot: undefined,
      check: { color: systemColors.label, size: MARK_SLOT_SIZE },
    });
  });

  it('paints consensus as a faint grade tint with a tinted ring', () => {
    expect(paint('consensus', 'grade')).toEqual({
      backgroundColor: withAlpha(GRADE_COLOR, 0.11),
      borderColor: withAlpha(GRADE_COLOR, 0.55),
      borderWidth: 1,
      textColor: undefined,
    });
  });

  it('keeps the dot on a consensus chip, so only a selected chip is checked', () => {
    const consensus = mark('consensus', 'grade');

    expect(consensus.dot?.color).toBe(GRADE_COLOR);
    expect(consensus.check).toBeUndefined();
  });

  // The range rail's "Any" chip stands for no grade, so it passes no colour.
  describe('with no grade colour', () => {
    it('draws no dot at rest and keeps the neutral fill', () => {
      expect(mark('neutral', 'grade', null)).toEqual({
        slotSize: MARK_SLOT_SIZE,
        dot: undefined,
        check: undefined,
      });
      const frame = flatten(captured.frameStyles.at(-1));
      expect(frame.backgroundColor).toBe(systemColors.fill);
    });

    it('takes a checkmark on the neutral fill, never the brand fill', () => {
      expect(mark('range', 'grade', null)).toEqual({
        slotSize: MARK_SLOT_SIZE,
        dot: undefined,
        check: { color: systemColors.label, size: MARK_SLOT_SIZE },
      });
      const frame = flatten(captured.frameStyles.at(-1));
      expect(frame.backgroundColor).toBe(systemColors.fill);
      expect(frame.backgroundColor).not.toBe(brandColors.primary);
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

  it.each<GradeChipTone>(['neutral', 'selected', 'range', 'consensus'])(
    'draws no dot, no checkmark and no mark slot on a %s chip',
    (tone) => {
      expect(mark(tone, 'selection')).toEqual({ slotSize: undefined, dot: undefined, check: undefined });
    },
  );

  it('keeps its content a plain centred box, with no row or gap for a mark', () => {
    renderChip('selected', 'selection');

    expect(contentStyle()).toEqual({
      minHeight: 42,
      paddingHorizontal: CHIP_PADDING_X,
      alignItems: 'center',
      justifyContent: 'center',
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
  const GRADE_TONES: GradeChipTone[] = ['neutral', 'range', 'selected', 'consensus'];

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

  it('keeps the same 1pt border on every grade tone, so no tone resizes the box', () => {
    for (const tone of GRADE_TONES) {
      expect(paint(tone, 'grade').borderWidth).toBe(1);
    }
  });

  it('holds the mark in one slot size on every grade tone, so the label never shifts', () => {
    // Dot, checkmark or neither: the slot in front of the label is the same
    // width, and the row gap beside it does not depend on the tone.
    for (const tone of GRADE_TONES) {
      expect(mark(tone, 'grade').slotSize).toBe(MARK_SLOT_SIZE);
      expect(contentStyle().gap).toBe(MARK_GAP);
    }
    // "Any" changes between an empty slot and a checkmark without resizing.
    expect(mark('neutral', 'grade', null).slotSize).toBe(mark('range', 'grade', null).slotSize);
  });

  it('scales the slot and the dot with the text size, up to the cap the checkmark glyph uses', () => {
    captured.fontScale = 1.3;
    const scaled = mark('neutral', 'grade');
    expect(scaled.slotSize).toBeCloseTo(MARK_SLOT_SIZE * 1.3);
    expect(scaled.dot?.size).toBeCloseTo(MARK_DOT_SIZE * 1.3);

    captured.fontScale = 3;
    expect(mark('neutral', 'grade').slotSize).toBeCloseTo(MARK_SLOT_SIZE * 1.5);
    // The checkmark is handed the same cap, so glyph and slot grow together.
    mark('selected', 'grade');
    expect((captured.icons.at(-1) as CapturedIcon).maxFontSizeMultiplier).toBe(1.5);
  });
});
