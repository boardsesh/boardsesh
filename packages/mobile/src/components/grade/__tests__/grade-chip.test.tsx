// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const theme = vi.hoisted(() => ({
  primary: '#3366AA',
}));

type StyleObject = {
  backgroundColor?: string;
  borderColor?: string;
};

function flattenStyle(style: unknown): StyleObject {
  const styleItems = Array.isArray(style) ? style : [style];
  return styleItems.reduce<StyleObject>((mergedStyle, styleItem) => {
    if (styleItem && typeof styleItem === 'object') {
      return { ...mergedStyle, ...(styleItem as StyleObject) };
    }
    return mergedStyle;
  }, {});
}

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    rippleColor,
    style,
  }: {
    children?: ReactNode;
    rippleColor?: string;
    style?: unknown;
  }) => {
    const flattenedStyle = flattenStyle(style);
    return createElement(
      'button',
      {
        'data-ripple-color': rippleColor,
        'data-background-color': flattenedStyle.backgroundColor,
        'data-border-color': flattenedStyle.borderColor,
      },
      children,
    );
  },
}));

vi.mock('../../Text', () => ({
  Text: ({ children, color }: { children?: ReactNode; color?: string }) =>
    createElement('span', { 'data-text-color': color }, children),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: '#EEEEEE' },
    brandColors: { primary: theme.primary },
  }),
}));

vi.mock('../../../theme/colors', () => ({
  withAlpha: (color: string, alpha: number) => `${color}@${alpha}`,
}));

vi.mock('../../../theme/tokens', () => ({ spacing: { 3: 12 } }));

import { GradeChip } from '../GradeChip';

describe('GradeChip', () => {
  beforeEach(() => {
    theme.primary = '#3366AA';
  });

  it('uses the resolved theme primary when no grade color is supplied', () => {
    const { getByRole } = render(
      <GradeChip label="Any" tone="selected" onPress={() => {}} accessibilityLabel="Any grade" />,
    );

    const chip = getByRole('button');
    expect(chip.getAttribute('data-ripple-color')).toBe('#3366AA');
    expect(chip.getAttribute('data-background-color')).toBe('#3366AA');
    expect(chip.getAttribute('data-border-color')).toBe('#3366AA');
  });

  it('uses the resolved theme primary for tonal range states', () => {
    const { getByRole } = render(
      <GradeChip label="Any" tone="range" onPress={() => {}} accessibilityLabel="Any grade" />,
    );

    const chip = getByRole('button');
    expect(chip.getAttribute('data-ripple-color')).toBe('#3366AA');
    expect(chip.getAttribute('data-background-color')).toBe('#3366AA@0.18');
    expect(chip.getAttribute('data-border-color')).toBe('#3366AA@0.75');
  });
});
