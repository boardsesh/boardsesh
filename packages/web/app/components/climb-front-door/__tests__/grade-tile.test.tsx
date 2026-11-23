import React from 'react';
import { describe, expect, it } from 'vite-plus/test';
import { DEFAULT_GRADE_COLOR, V_GRADE_COLORS } from '@/app/lib/grade-colors';
import GradeTile, { contrastRatio, gradeTileInk } from '../grade-tile';

type TileElement = React.ReactElement<{
  sx: { bgcolor: string; color: string };
  children: React.ReactNode;
}>;

/** The Font-grade line's `sx`, the tile's second child. */
function fontGradeSx(tile: TileElement): Record<string, unknown> {
  const [, fontGrade] = React.Children.toArray(tile.props.children) as Array<React.ReactElement<{ sx: object }>>;
  if (!fontGrade) throw new Error('the tile rendered no Font grade line');
  return fontGrade.props.sx as Record<string, unknown>;
}

describe('contrastRatio', () => {
  it('measures WCAG 2 contrast', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
  });
});

describe('GradeTile ink', () => {
  it.each(Object.entries({ ...V_GRADE_COLORS, default: DEFAULT_GRADE_COLOR }))(
    'prints %s (%s) at 4.5:1 or better',
    (_grade, gradeColor) => {
      expect(contrastRatio(gradeTileInk(gradeColor), gradeColor)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(Object.keys(V_GRADE_COLORS))('prints both lines of a %s tile in full ink', (vGrade) => {
    const tile = GradeTile({ difficulty: `6a/${vGrade}`, boardName: 'kilter' }) as TileElement;
    const gradeColor = V_GRADE_COLORS[vGrade];
    expect(tile.props.sx.bgcolor).toBe(gradeColor);
    expect(tile.props.sx.color).toBe(gradeTileInk(gradeColor));
    // The Font grade inherits the tile's ink; any opacity would cut its contrast.
    expect(fontGradeSx(tile)).not.toHaveProperty('opacity');
    expect(fontGradeSx(tile)).not.toHaveProperty('color');
  });

  it("picks the dark ink on V5's red, where a brightness cut-off picked white at 3.84:1", () => {
    expect(contrastRatio(gradeTileInk(V_GRADE_COLORS.V5), V_GRADE_COLORS.V5)).toBeGreaterThan(4.5);
    expect(contrastRatio('#FFFFFF', V_GRADE_COLORS.V5)).toBeLessThan(4.5);
  });
});

type ChipElement = React.ReactElement<{
  sx: { bgcolor: string; color: string; height: number };
  children: React.ReactNode;
  'aria-hidden': boolean;
}>;

describe('GradeTile compact chip', () => {
  it.each(Object.keys(V_GRADE_COLORS))('prints a %s chip as the V-grade alone, in the same readable ink', (vGrade) => {
    const chip = GradeTile({ difficulty: `6a/${vGrade}`, boardName: 'kilter', size: 'compact' }) as ChipElement;
    const gradeColor = V_GRADE_COLORS[vGrade];

    expect(chip.props.children).toBe(vGrade);
    expect(chip.props.sx.bgcolor).toBe(gradeColor);
    expect(contrastRatio(chip.props.sx.color, gradeColor)).toBeGreaterThanOrEqual(4.5);
    expect(chip.props.sx.height).toBeLessThan(44);
    expect(chip.props['aria-hidden']).toBe(true);
  });

  it('renders nothing for a climb with no V-grade', () => {
    expect(GradeTile({ difficulty: null, boardName: 'kilter', size: 'compact' })).toBeNull();
  });
});
