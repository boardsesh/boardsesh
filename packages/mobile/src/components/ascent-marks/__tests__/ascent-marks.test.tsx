// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  View: ({
    children,
    accessibilityLabel,
    accessibilityElementsHidden,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityElementsHidden?: boolean;
  }) =>
    createElement(
      'div',
      { 'aria-label': accessibilityLabel, 'aria-hidden': accessibilityElementsHidden ? 'true' : undefined },
      children,
    ),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Platform: { OS: 'ios' },
  PlatformColor: (name: string) => name,
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => (opts?.count === undefined ? key : `${key}:${opts.count}`),
  }),
}));
const theme = vi.hoisted(() => ({ colorScheme: 'light' as 'light' | 'dark' }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    colorScheme: theme.colorScheme,
    brandColors: { primary: '#primary', primaryFill: '#primaryFill' },
    systemColors: { secondaryLabel: '#secondary' },
  }),
}));
vi.mock('@boardsesh/board-constants/grade-colors', () => ({
  getGradeColor: () => '#abcdef',
  DEFAULT_GRADE_COLOR: '#000000',
}));
vi.mock('../../../hooks/use-grade-format', () => ({
  useGradeFormat: () => ({
    formatGradeByDifficultyId: (id: number | null | undefined) => (id == null ? null : `V${id}`),
  }),
}));

import { AscentStatusMark, GradePill, StarNumber } from '..';

describe('AscentStatusMark', () => {
  it.each([
    ['flash', 'flash'],
    ['send', 'check.small'],
    ['attempt', 'minus'],
  ] as const)('draws %s with the %s glyph', (status, glyph) => {
    const { container } = render(createElement(AscentStatusMark, { status }));
    expect(container.querySelectorAll('[data-icon]')).toHaveLength(1);
    expect(container.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe(glyph);
  });

  it('stays out of the accessibility tree', () => {
    const { container } = render(createElement(AscentStatusMark, { status: 'send' }));
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('GradePill', () => {
  it('renders the grade the climber gave', () => {
    const { getByText } = render(createElement(GradePill, { difficultyId: 16 }));
    expect(getByText('V16')).toBeTruthy();
  });

  it.each([null, undefined])('renders nothing for %s', (difficultyId) => {
    const { container } = render(createElement(GradePill, { difficultyId }));
    expect(container.innerHTML).toBe('');
  });
});

describe('StarNumber', () => {
  it.each([0, null, undefined])('renders nothing for %s', (quality) => {
    const { container } = render(createElement(StarNumber, { quality }));
    expect(container.innerHTML).toBe('');
  });

  it('shows one star, the number, and a spoken label', () => {
    const { container } = render(createElement(StarNumber, { quality: 4 }));
    expect(container.querySelectorAll('[data-icon="star.fill"]')).toHaveLength(1);
    expect(container.textContent).toBe('4');
    expect(container.firstElementChild?.getAttribute('aria-label')).toBe('mobile.logbook.starsA11y:4');
  });

  it('uses the darker gold on a light surface and the bright gold in dark', () => {
    theme.colorScheme = 'light';
    const light = render(createElement(StarNumber, { quality: 3 }));
    expect(light.container.querySelector('[data-icon]')?.getAttribute('data-color')).toBe('#C27803');
    theme.colorScheme = 'dark';
    const dark = render(createElement(StarNumber, { quality: 3 }));
    expect(dark.container.querySelector('[data-icon]')?.getAttribute('data-color')).toBe('#FFB800');
    theme.colorScheme = 'light';
  });
});
