// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// react-native isn't satisfiable under jsdom; stub the surface the label touches.
// See play-drawer-header-stats-angle.test.tsx for the same pattern.
vi.mock('react-native', () => ({
  View: ({
    children,
    accessible,
    accessibilityLabel,
    testID,
  }: {
    children?: ReactNode;
    accessible?: boolean;
    accessibilityLabel?: string;
    testID?: string;
  }) =>
    createElement(
      'div',
      { 'data-accessible': accessible ? 'true' : undefined, 'aria-label': accessibilityLabel, 'data-testid': testID },
      children,
    ),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: 'secondaryLabel' } }),
}));
vi.mock('../../Text', () => ({
  Text: ({
    children,
    numberOfLines,
    style,
  }: {
    children?: ReactNode;
    numberOfLines?: number;
    style?: { flexShrink?: number };
  }) =>
    createElement(
      'span',
      { 'data-lines': numberOfLines, 'data-shrink': style?.flexShrink === undefined ? undefined : style.flexShrink },
      children,
    ),
}));

import { PlayListContext } from '../PlayListContext';

const texts = (container: HTMLElement) => Array.from(container.querySelectorAll('span'));

describe('PlayListContext', () => {
  it('prints the name and the count as two texts, and only the name may shrink', () => {
    const { container } = render(
      createElement(PlayListContext, {
        parts: { name: 'Search results', count: '1 of 29,182', accessibilityLabel: 'Playing from Search results' },
      }),
    );
    const [name, count] = texts(container);
    expect(name?.textContent).toBe('Search results');
    expect(name?.getAttribute('data-shrink')).toBe('1');
    expect(name?.getAttribute('data-lines')).toBe('1');
    expect(count?.textContent).toBe(' · 1 of 29,182');
    expect(count?.getAttribute('data-shrink')).toBe('0');
  });

  it('prints the name alone when the count is not known', () => {
    const { container } = render(
      createElement(PlayListContext, {
        parts: { name: 'Projects', count: null, accessibilityLabel: 'Playing from Projects' },
      }),
    );
    expect(texts(container).map((text) => text.textContent)).toEqual(['Projects']);
  });

  // One element for VoiceOver, with the whole name even when the layout cuts it.
  it('reads as one element with the full label', () => {
    const { container } = render(
      createElement(PlayListContext, {
        parts: {
          name: 'Winter crimp ladder, 40° only, no dynos please',
          count: '4 of 23',
          accessibilityLabel: 'Playing from Winter crimp ladder, 40° only, no dynos please, 4 of 23',
        },
        testID: 'play-drawer-track-label',
      }),
    );
    const group = container.querySelector('[data-testid="play-drawer-track-label"]');
    expect(group?.getAttribute('data-accessible')).toBe('true');
    expect(group?.getAttribute('aria-label')).toBe(
      'Playing from Winter crimp ladder, 40° only, no dynos please, 4 of 23',
    );
  });
});
