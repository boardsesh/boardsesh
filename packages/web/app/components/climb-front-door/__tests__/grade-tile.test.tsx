import React from 'react';
import { describe, expect, it } from 'vite-plus/test';
import { contrastRatio, DEFAULT_GRADE_COLOR, getReadableGradeInk, V_GRADE_COLORS } from '@/app/lib/grade-colors';
import GradeTile from '../grade-tile';

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

describe('GradeTile ink', () => {
  it.each(Object.entries({ ...V_GRADE_COLORS, default: DEFAULT_GRADE_COLOR }))(
    'prints %s (%s) at 4.5:1 or better',
    (_grade, gradeColor) => {
      expect(contrastRatio(getReadableGradeInk(gradeColor), gradeColor)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(Object.keys(V_GRADE_COLORS))('prints both lines of a %s tile in full ink', (vGrade) => {
    const tile = GradeTile({ difficulty: `6a/${vGrade}`, boardName: 'kilter' }) as TileElement;
    const gradeColor = V_GRADE_COLORS[vGrade];
    expect(tile.props.sx.bgcolor).toBe(gradeColor);
    expect(tile.props.sx.color).toBe(getReadableGradeInk(gradeColor));
    expect(contrastRatio(tile.props.sx.color, gradeColor)).toBeGreaterThanOrEqual(4.5);
    // The Font grade inherits the tile's ink; any opacity would cut its contrast.
    expect(fontGradeSx(tile)).not.toHaveProperty('opacity');
    expect(fontGradeSx(tile)).not.toHaveProperty('color');
  });

  it("picks the dark ink on V5's red, where a brightness cut-off picked white at 3.84:1", () => {
    expect(contrastRatio(getReadableGradeInk(V_GRADE_COLORS.V5), V_GRADE_COLORS.V5)).toBeGreaterThan(4.5);
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
