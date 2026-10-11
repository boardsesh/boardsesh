// @vitest-environment jsdom
//
// GradeChip paints from two palettes and the two must not bleed into each other.
// `grade` is the filter rails' palette: a neutral pill at rest, the solid grade
// colour once selected, a wash of that colour inside a range. `selection` is
// the tick sheets' palette, where the chip answers "which one did I pick?" in
// violet and amber and the grade ramp lives in the header instead.
//
// This test pins four things:
//   1. `grade` state is never hue alone: resting, in range and selected each
//      have their own fill AND their own border.
//   2. The chip is its label and nothing else: no dot, no checkmark, no slot.
//   3. `selection`'s selected tone is the brand fill with `onPrimary` text.
//   4. The box geometry does not move between tones. React Native is border-box,
//      so a tone that changes `borderWidth` resizes the content box under the
//      label — which is exactly what a 0pt selected border did.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type CapturedStyle = Record<string, unknown>;

const captured = vi.hoisted(() => ({
  frameProps: [] as unknown[],
  frameStyles: [] as unknown[],
  textColors: [] as unknown[],
  viewStyles: [] as unknown[],
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) => {
    captured.viewStyles.push(style);
    return createElement('div', { 'data-chip-view': 'true' }, children);
  },
}));

vi.mock('../../PressableSurface', () => ({
  PressableSurface: (props: { children?: ReactNode; style?: unknown }) => {
    captured.frameProps.push(props);
    captured.frameStyles.push(props.style);
    return createElement('div', { 'data-chip-frame': 'true' }, props.children);
  },
}));

vi.mock('../../Text', () => ({
  Text: ({ children, color }: { children?: ReactNode; color?: unknown }) => {
    captured.textColors.push(color);
    return createElement('span', { 'data-chip-text': 'true' }, children);
  },
}));

vi.mock('../../../providers/theme-provider', async () => {
  const { makeThemeMock } = await import('../../../test/theme-mock');
  const theme = makeThemeMock();
  return { useTheme: () => theme };
});

import { GRADE_CHIP_HEIGHT, GradeChip, type GradeChipColorway, type GradeChipTone } from '../GradeChip';
import { makeThemeMock } from '../../../test/theme-mock';
import { withAlpha } from '../../../theme/colors';
import { spacing } from '../../../theme/tokens';
import { readableTextColor } from '../grade-chip-colors';

const theme = makeThemeMock();
const { systemColors, brandColors, chartColors } = theme;

/** A mid-ramp grade colour. Hex because `withAlpha` only speaks hex, and mid-ramp
 *  so `readableTextColor` has a real decision to make. */
const GRADE_COLOR = '#D64541';

/** Geometry constants mirrored from `GradeChip`'s stylesheet. Duplicated on
 *  purpose: the point is to catch a change to them, so reading them back from the
 *  component would defeat the assertion. */
const CHIP_HEIGHT = 44;
const CHIP_MIN_WIDTH = 52;
const CHIP_PADDING_X = spacing[3];
/** The ring round a selected chip: the label colour at 45%. From the theme's
 *  plain-string palette, since `withAlpha` reads hex. */
const SELECTED_RING = withAlpha(chartColors.label, 0.45);

const ALL_TONES: GradeChipTone[] = ['neutral', 'range', 'selected', 'consensus'];

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

/** `null` renders the chip with no grade colour at all, as the range rail's "Any" does. */
function renderChip(tone: GradeChipTone, colorway: GradeChipColorway, gradeColor: string | null = GRADE_COLOR) {
  captured.frameProps = [];
  captured.frameStyles = [];
  captured.textColors = [];
  captured.viewStyles = [];
  return render(
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

function paint(tone: GradeChipTone, colorway: GradeChipColorway, gradeColor: string | null = GRADE_COLOR): ChipPaint {
  renderChip(tone, colorway, gradeColor);
  const frame = flatten(captured.frameStyles.at(-1));
  return {
    backgroundColor: frame.backgroundColor,
    borderColor: frame.borderColor,
    borderWidth: frame.borderWidth as number,
    textColor: captured.textColors.at(-1),
  };
}

/** The style of the one view inside the chip: the box the label is centred in. */
function contentStyle(): CapturedStyle {
  return flatten(captured.viewStyles[0]);
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
  captured.frameProps = [];
  captured.frameStyles = [];
  captured.textColors = [];
  captured.viewStyles = [];
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

  it('paints selected in the solid grade colour with readable text and a label-colour ring', () => {
    expect(paint('selected', 'grade')).toEqual({
      backgroundColor: GRADE_COLOR,
      // A dark grade colour on a dark background has no edge of its own.
      borderColor: SELECTED_RING,
      borderWidth: 1,
      textColor: readableTextColor(GRADE_COLOR),
    });
  });

  it('paints a chip inside a range as a wash of its own grade colour with a ring of it', () => {
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

  it('tells resting, in range and selected apart by fill and by border, not by hue alone', () => {
    const paints = (['neutral', 'range', 'selected'] as const).map((tone) => paint(tone, 'grade'));

    expect(new Set(paints.map((chip) => chip.backgroundColor)).size).toBe(3);
    expect(new Set(paints.map((chip) => chip.borderColor)).size).toBe(3);
  });

  // The range rail's "Any" chip stands for no grade, so it passes no colour.
  describe('with no grade colour', () => {
    it('is a plain neutral chip at rest', () => {
      expect(paint('neutral', 'grade', null)).toEqual(paint('neutral', 'grade'));
    });

    it('shows selected with the ring and nothing else: neutral fill, never a brand fill', () => {
      const selectedAny = paint('selected', 'grade', null);

      expect(selectedAny).toEqual({
        backgroundColor: systemColors.fill,
        borderColor: SELECTED_RING,
        borderWidth: 1,
        textColor: undefined,
      });
      expect(selectedAny.backgroundColor).not.toBe(brandColors.primary);
      expect(selectedAny.backgroundColor).not.toBe(brandColors.primaryFill);
    });

    it('has no colour to wash an in-range chip with, so it stays neutral', () => {
      expect(paint('range', 'grade', null)).toEqual(paint('neutral', 'grade'));
    });
  });
});

describe('GradeChip is its label and nothing else', () => {
  it.each((['grade', 'selection'] as const).flatMap((colorway) => ALL_TONES.map((tone) => [colorway, tone] as const)))(
    'draws no dot, no checkmark and no mark slot (%s, %s)',
    (colorway, tone) => {
      const { container } = renderChip(tone, colorway);

      // One view (the content box) holding one text (the label).
      expect(container.querySelectorAll('[data-chip-view]')).toHaveLength(1);
      expect(container.querySelectorAll('[data-chip-text]')).toHaveLength(1);
      expect(container.querySelector('[data-chip-view]')?.children).toHaveLength(1);
      expect(container.textContent).toBe('V6');
    },
  );

  it.each(['grade', 'selection'] as const)('centres the label in a plain box, with no row or gap (%s)', (colorway) => {
    renderChip('selected', colorway);

    expect(contentStyle()).toEqual({
      minHeight: CHIP_HEIGHT - 2,
      paddingHorizontal: CHIP_PADDING_X,
      alignItems: 'center',
      justifyContent: 'center',
    });
  });
});

describe('GradeChip colorway="selection"', () => {
  it('resolves the selected tone to the brand fill with onPrimary text', () => {
    const selected = paint('selected', 'selection');

    expect(selected.backgroundColor).toBe(brandColors.primaryFill);
    expect(selected.borderColor).toBe(brandColors.primaryFill);
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

  it('has no in-range look: the tick sheets never pick a range', () => {
    expect(paint('range', 'selection')).toEqual(paint('neutral', 'selection'));
  });

  it('takes nothing from the grade colorway: no grade wash, no label-colour ring', () => {
    for (const tone of ALL_TONES) {
      const chip = paint(tone, 'selection');
      expect(chip.borderColor).not.toBe(SELECTED_RING);
      expect(chip.backgroundColor).not.toBe(withAlpha(GRADE_COLOR, 0.18));
    }
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

  it('lays every grade tone out to one outer width and one label box', () => {
    const neutral = paint('neutral', 'grade');
    for (const tone of ALL_TONES) {
      const chip = paint(tone, 'grade');
      expect(chip.borderWidth).toBe(1);
      expect(outerBoxWidth(chip, LABEL_WIDTH)).toBe(outerBoxWidth(neutral, LABEL_WIDTH));
      expect(contentBoxWidth(chip, LABEL_WIDTH)).toBe(contentBoxWidth(neutral, LABEL_WIDTH));
    }
    // "Any" too, as it goes from resting to selected.
    expect(paint('selected', 'grade', null).borderWidth).toBe(paint('neutral', 'grade', null).borderWidth);
  });

  it('keeps the selected tone the same size in both colorways', () => {
    expect(outerBoxWidth(paint('selected', 'selection'), LABEL_WIDTH)).toBe(
      outerBoxWidth(paint('selected', 'grade'), LABEL_WIDTH),
    );
  });

  it('sizes the chip from the one exported height', () => {
    expect(GRADE_CHIP_HEIGHT).toBe(CHIP_HEIGHT);
    for (const colorway of ['grade', 'selection'] as const) {
      renderChip('neutral', colorway);
      expect(flatten(captured.frameStyles.at(-1))).toMatchObject({
        minHeight: GRADE_CHIP_HEIGHT,
        borderRadius: GRADE_CHIP_HEIGHT / 2,
      });
      // Inside the 1pt border at the top and at the bottom.
      expect(contentStyle().minHeight).toBe(GRADE_CHIP_HEIGHT - 2);
    }
  });
});

describe('GradeChip touch and hold', () => {
  it('hands the hold and its delay to the pressable, beside the tap', () => {
    const onPress = vi.fn();
    const onLongPress = vi.fn();
    render(
      createElement(GradeChip, {
        label: 'V6',
        gradeColor: GRADE_COLOR,
        onPress,
        onLongPress,
        delayLongPress: 400,
        accessibilityLabel: 'V6',
      }),
    );

    expect(captured.frameProps.at(-1)).toMatchObject({ onPress, onLongPress, delayLongPress: 400 });
  });

  it('has no hold unless one is given', () => {
    renderChip('neutral', 'grade');
    const frame = captured.frameProps.at(-1) as { onLongPress?: unknown };

    expect(frame.onLongPress).toBeUndefined();
  });
});
