import { describe, it, expect } from 'vite-plus/test';
import {
  V_GRADE_COLORS,
  DARK_GRADE_REFERENCE_SURFACE,
  readableGradeColor,
  readableGradeColorOnTint,
} from '../grade-colors';
import { compositeOver, contrastRatio, liftToContrast } from '../readable-text-color';

// Every dark surface a grade is drawn on: the reference (iOS tertiary), the
// Material cards and page, and the near-black feed card from the issue (#6917).
const DARK_SURFACES = [DARK_GRADE_REFERENCE_SURFACE, '#221A33', '#181225', '#1A1228', '#0F0B16', '#1C1C1E', '#000000'];

function mixTowardWhite(hexColor: string, mix: number): string {
  const channel = (offset: number) => {
    const value = parseInt(hexColor.slice(offset, offset + 2), 16);
    return Math.round(value + (255 - value) * mix)
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

function hue(hexColor: string): number {
  const red = parseInt(hexColor.slice(1, 3), 16) / 255;
  const green = parseInt(hexColor.slice(3, 5), 16) / 255;
  const blue = parseInt(hexColor.slice(5, 7), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  if (max === min) return 0;
  const delta = max - min;
  let value: number;
  if (max === red) value = ((green - blue) / delta) % 6;
  else if (max === green) value = (blue - red) / delta + 2;
  else value = (red - green) / delta + 4;
  return (value * 60 + 360) % 360;
}

describe('readableGradeColor', () => {
  it('clears 4.5:1 for text on every dark surface, for every V-grade', () => {
    for (const [grade, color] of Object.entries(V_GRADE_COLORS)) {
      const readable = readableGradeColor(color, 'dark', 'text');
      for (const surface of DARK_SURFACES) {
        expect(contrastRatio(readable, surface), `${grade} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('clears 3:1 for marks on every dark surface, for every V-grade', () => {
    for (const [grade, color] of Object.entries(V_GRADE_COLORS)) {
      const readable = readableGradeColor(color, 'dark', 'mark');
      for (const surface of DARK_SURFACES) {
        expect(contrastRatio(readable, surface), `${grade} on ${surface}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('leaves the grades that already read on dark untouched', () => {
    // V4 sits at 4.27:1 on the lightest (iOS) surface, so it takes a slight lift.
    for (const grade of ['V0', 'V1', 'V2', 'V3']) {
      expect(readableGradeColor(V_GRADE_COLORS[grade], 'dark', 'text')).toBe(V_GRADE_COLORS[grade]);
    }
  });

  it('keeps each lifted grade on its own hue', () => {
    for (const [grade, color] of Object.entries(V_GRADE_COLORS)) {
      const readable = readableGradeColor(color, 'dark', 'text');
      const drift = Math.abs(hue(readable) - hue(color));
      expect(Math.min(drift, 360 - drift), grade).toBeLessThanOrEqual(6);
    }
  });

  // The lifted V14–V17 sit in a narrow lavender band; this only guards that they
  // don't collapse onto one colour. The grade label carries the difference.
  it('maps distinct hard grades to distinct colours', () => {
    const lifted = ['V14', 'V15', 'V16', 'V17'].map((grade) => readableGradeColor(V_GRADE_COLORS[grade], 'dark'));
    expect(new Set(lifted).size).toBe(lifted.length);
  });

  it('returns the colour unchanged in light mode', () => {
    for (const color of Object.values(V_GRADE_COLORS)) {
      expect(readableGradeColor(color, 'light', 'text')).toBe(color);
      expect(readableGradeColor(color, 'light', 'mark')).toBe(color);
    }
  });

  it('defaults to the text threshold', () => {
    expect(readableGradeColor(V_GRADE_COLORS.V16, 'dark')).toBe(readableGradeColor(V_GRADE_COLORS.V16, 'dark', 'text'));
  });
});

describe('liftToContrast', () => {
  it('returns a passing colour unchanged', () => {
    expect(liftToContrast('#FFD400', '#000000', 4.5)).toBe('#FFD400');
  });

  it('lifts only as far as needed', () => {
    const surface = '#2C2C2E';
    const lifted = liftToContrast('#38006B', surface, 4.5);
    expect(contrastRatio(lifted, surface)).toBeGreaterThanOrEqual(4.5);
    // Rebuild the 1% mixes toward white: the one just before the returned colour
    // must still fail, or the lift went further than it needed to.
    const mixes = Array.from({ length: 101 }, (_, step) => mixTowardWhite('#38006B', step / 100));
    const liftedStep = mixes.indexOf(lifted);
    expect(liftedStep).toBeGreaterThan(0);
    expect(contrastRatio(mixes[liftedStep - 1], surface)).toBeLessThan(4.5);
  });

  it('returns white when nothing short of white passes', () => {
    expect(liftToContrast('#38006B', '#808080', 21)).toBe('#FFFFFF');
  });

  it('passes an invalid colour through', () => {
    expect(liftToContrast('not-a-color', '#000000', 4.5)).toBe('not-a-color');
  });
});

describe('compositeOver', () => {
  it('blends a colour over a background at the given alpha', () => {
    expect(compositeOver('#FFFFFF', 0.5, '#000000')).toBe('#808080');
    expect(compositeOver('#FF0000', 0, '#2C2C2E')).toBe('#2C2C2E');
    expect(compositeOver('#FF0000', 1, '#2C2C2E')).toBe('#FF0000');
  });

  it('returns the background for an invalid colour', () => {
    expect(compositeOver('not-a-color', 0.5, '#2C2C2E')).toBe('#2C2C2E');
  });
});

describe('readableGradeColorOnTint', () => {
  it('clears 4.5:1 on a 15% tint of its own grade, for every V-grade', () => {
    for (const [grade, color] of Object.entries(V_GRADE_COLORS)) {
      const tint = compositeOver(color, 0.15, DARK_GRADE_REFERENCE_SURFACE);
      expect(contrastRatio(readableGradeColorOnTint(color, 'dark', 0.15), tint), grade).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('returns the colour unchanged in light mode', () => {
    expect(readableGradeColorOnTint(V_GRADE_COLORS.V16, 'light', 0.15)).toBe(V_GRADE_COLORS.V16);
  });
});

describe('readableGradeColor surfaceColor', () => {
  it('lifts against a lighter surface when one is passed', () => {
    const container = '#3F246F';
    const onContainer = readableGradeColor(V_GRADE_COLORS.V16, 'dark', 'mark', container);
    expect(contrastRatio(onContainer, container)).toBeGreaterThanOrEqual(3);
    expect(onContainer).not.toBe(readableGradeColor(V_GRADE_COLORS.V16, 'dark', 'mark'));
  });
});
