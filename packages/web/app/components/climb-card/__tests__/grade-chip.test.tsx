import React from 'react';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { cleanup, render } from '@testing-library/react';
import { V_GRADE_COLORS, getFontGradeColor } from '@/app/lib/grade-colors';
import GradeChip from '../grade-chip';

/** `#FFD400` → `rgb(255, 212, 0)`, the form a computed style reports. */
function hexToRgb(hex: string): string {
  const value = hex.replace('#', '');
  const [red, green, blue] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  return `rgb(${red}, ${green}, ${blue})`;
}

function chipStyle(label: string) {
  const { container } = render(<GradeChip label={label} />);
  const chip = container.querySelector('span');
  if (!chip) throw new Error('no chip rendered');
  return { text: chip.textContent, style: getComputedStyle(chip) };
}

afterEach(cleanup);

describe('GradeChip', () => {
  it('fills the chip with the grade colour and puts dark ink on a light one', () => {
    const { text, style } = chipStyle('V0');

    expect(text).toBe('V0');
    expect(style.backgroundColor).toBe(hexToRgb(V_GRADE_COLORS.V0));
    expect(style.color).toBe('rgb(0, 0, 0)');
  });

  it('puts light ink on a dark grade colour', () => {
    const { style } = chipStyle('V12');

    expect(style.backgroundColor).toBe(hexToRgb(V_GRADE_COLORS.V12));
    expect(style.color).toBe('rgb(255, 255, 255)');
  });

  it('picks ink by contrast, so V5 red gets dark ink (white is 3.8:1 there)', () => {
    expect(chipStyle('V5').style.color).toBe('rgb(0, 0, 0)');
  });

  it('colours a Font label by its Font grade', () => {
    const fontColour = getFontGradeColor('6c+');
    if (!fontColour) throw new Error('6c+ has no Font colour');

    expect(chipStyle('6C+').style.backgroundColor).toBe(hexToRgb(fontColour));
  });

  it('never cuts a V-grade: the whole label, on one line, in a chip that will not shrink', () => {
    const { text, style } = chipStyle('V5+ / 6C+');

    expect(text).toBe('V5+ / 6C+');
    expect(style.whiteSpace).toBe('nowrap');
    expect(style.flexShrink).toBe('0');
    expect(style.textOverflow).not.toBe('ellipsis');
    expect(style.overflow).not.toBe('hidden');
  });

  it('draws a grade with no colour on the quiet surface rather than a guessed colour', () => {
    expect(chipStyle('Project').style.backgroundColor).toBe('var(--semantic-surface-elevated)');
  });
});
