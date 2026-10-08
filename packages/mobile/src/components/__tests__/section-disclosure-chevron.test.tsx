// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Reanimated's ESM entry isn't resolvable under vitest, so it's stubbed — but
// faithfully: `useDerivedValue` runs its factory and `withTiming` returns the
// target, so the rotation actually computed from `expanded` is observable. That
// is the one piece of logic this component owns; the native animation itself is
// a device concern.
vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children, style }: { children?: ReactNode; style?: Record<string, unknown> }) =>
      createElement('div', { 'data-transform': JSON.stringify(style?.transform ?? null) }, children),
  },
  useDerivedValue: (factory: () => number) => ({ value: factory() }),
  useAnimatedStyle: (factory: () => Record<string, unknown>) => factory(),
  withTiming: (value: number) => value,
}));
vi.mock('../Icon', () => ({
  Icon: ({ name, size, color }: { name: string; size?: number; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-size': String(size), 'data-color': color }),
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { tertiaryLabel: 'theme-tertiary-label' } }),
}));
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios' },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
}));

import { SectionDisclosureChevron } from '../SectionDisclosureChevron';

function transformOf(container: HTMLElement): string | null {
  return container.querySelector('[data-transform]')?.getAttribute('data-transform') ?? null;
}

describe('SectionDisclosureChevron', () => {
  it('draws the chevron in the adaptive tertiaryLabel, not a static grey', () => {
    const { container } = render(createElement(SectionDisclosureChevron, { expanded: false }));
    expect(container.querySelector('[data-icon]')?.getAttribute('data-color')).toBe('theme-tertiary-label');
  });

  it('points down (0deg) when collapsed', () => {
    const { container } = render(createElement(SectionDisclosureChevron, { expanded: false }));
    expect(transformOf(container)).toContain('0deg');
  });

  it('flips 180deg when expanded', () => {
    const { container } = render(createElement(SectionDisclosureChevron, { expanded: true }));
    expect(transformOf(container)).toContain('180deg');
  });

  it('rotates when the expanded prop changes', () => {
    const { container, rerender } = render(createElement(SectionDisclosureChevron, { expanded: false }));
    expect(transformOf(container)).toContain('0deg');

    rerender(createElement(SectionDisclosureChevron, { expanded: true }));
    expect(transformOf(container)).toContain('180deg');
  });

  it('renders the chevron glyph at the requested size', () => {
    const { container } = render(createElement(SectionDisclosureChevron, { expanded: true, size: 18 }));
    const icon = container.querySelector('[data-icon]');
    expect(icon?.getAttribute('data-icon')).toBe('chevron.down');
    expect(icon?.getAttribute('data-size')).toBe('18');
  });
});
