// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
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
const theme = vi.hoisted(() => ({ colorScheme: 'light' as 'light' | 'dark' }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: 'secondaryLabel' }, colorScheme: theme.colorScheme }),
}));
vi.mock('../../../theme/colors', () => ({
  materialSurfaces: { light: { secondaryLabel: '#5B5563' }, dark: { secondaryLabel: '#A9A2B6' } },
}));
// The iOS viewer's title, recorded so the test can read what it would show.
vi.mock('../../LargeContentViewer', () => ({
  LargeContentViewer: ({ title, children }: { title: string; children?: ReactNode }) =>
    createElement('section', { 'data-large-content-title': title }, children),
}));
// Android's answer: font scaling off, the line height scaled by hand (see
// use-capped-text-props). The label must hand it to every one of its texts.
vi.mock('../../../hooks/use-capped-text-props', () => ({
  useCappedTextProps: () => ({ allowFontScaling: false, style: { lineHeight: 19.2 } }),
}));
type MockTextStyle = { flexShrink?: number; textAlign?: string; lineHeight?: number };
vi.mock('../../Text', () => ({
  Text: ({
    children,
    numberOfLines,
    numeric,
    allowFontScaling,
    color,
    style,
  }: {
    children?: ReactNode;
    numberOfLines?: number;
    numeric?: boolean;
    allowFontScaling?: boolean;
    color?: string;
    style?: MockTextStyle | MockTextStyle[];
  }) => {
    const flat: MockTextStyle = Object.assign({}, ...[style].flat().filter(Boolean));
    return createElement(
      'span',
      {
        'data-color': color,
        'data-lines': numberOfLines,
        'data-numeric': numeric ? 'true' : undefined,
        'data-shrink': flat.flexShrink === undefined ? undefined : flat.flexShrink,
        'data-align': flat.textAlign,
        'data-font-scaling': String(allowFontScaling),
        'data-line-height': flat.lineHeight,
      },
      children,
    );
  },
}));

import { PlayListContext } from '../PlayListContext';

beforeEach(() => {
  theme.colorScheme = 'light';
});

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
    expect(count?.getAttribute('data-numeric')).toBe('true');
  });

  // A cut name's "…" stops short of its box; right-aligned, the spare room
  // falls on the outer edge instead of between the name and the count.
  it('right-aligns the name so a cut one sits against the count', () => {
    const { container } = render(
      createElement(PlayListContext, {
        parts: { name: 'Projects', count: '4 of 23', accessibilityLabel: 'Playing from Projects, 4 of 23' },
      }),
    );
    expect(texts(container)[0]?.getAttribute('data-align')).toBe('right');
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

  // The second line #6745 made room for: the preview caption rides it instead
  // of leading the header's stats line, where it pushed the sends and stars off.
  // A screen reader hears its "·" as a comma, never "middle dot" (B1).
  it('adds the wall caption as a second line, read with the list', () => {
    const { container } = render(
      createElement(PlayListContext, {
        parts: { name: 'Projects', count: '4 of 23', accessibilityLabel: 'Playing from Projects, 4 of 23' },
        caption: 'Preview · not on the wall',
        testID: 'play-drawer-track-label',
      }),
    );
    expect(texts(container).map((text) => text.textContent)).toEqual([
      'Projects',
      ' · 4 of 23',
      'Preview · not on the wall',
    ]);
    expect(container.querySelector('[data-testid="play-drawer-track-label"]')?.getAttribute('aria-label')).toBe(
      'Playing from Projects, 4 of 23. Preview, not on the wall',
    );
  });

  it('shows the caption alone when there is no list', () => {
    const { container } = render(createElement(PlayListContext, { parts: null, caption: 'Preview · not on the wall' }));
    expect(texts(container).map((text) => text.textContent)).toEqual(['Preview · not on the wall']);
  });

  // iOS's translucent secondaryLabel is 3.44:1 on a white sheet; Velvet's
  // opaque one clears 6:1 on every ground (wall-control-button-contrast.test.ts).
  it.each([
    ['light', '#5B5563'],
    ['dark', '#A9A2B6'],
  ] as const)('draws the caption in Velvet secondary label in %s', (scheme, color) => {
    theme.colorScheme = scheme;
    const { container } = render(createElement(PlayListContext, { parts: null, caption: 'Preview · not on the wall' }));
    expect(texts(container)[0]?.getAttribute('data-color')).toBe(color);
  });

  // The bar is capped at 1.2x, so the Large Content Viewer is how the words
  // reach someone who needs them larger.
  it('hands the Large Content Viewer both lines as printed', () => {
    const { container } = render(
      createElement(PlayListContext, {
        parts: { name: 'Projects', count: '4 of 23', accessibilityLabel: 'Playing from Projects, 4 of 23' },
        caption: 'Preview · not on the wall',
      }),
    );
    expect(container.querySelector('section')?.getAttribute('data-large-content-title')).toBe(
      'Projects · 4 of 23. Preview · not on the wall',
    );
  });

  it('renders nothing with neither', () => {
    const { container } = render(createElement(PlayListContext, { parts: null }));
    expect(container.innerHTML).toBe('');
  });

  // At Android's 2.0 text size the line heights grew past the cap and the
  // first line ran into the grabber (#6702 QA).
  it('hands every text the capped scaling, line height included', () => {
    const { container } = render(
      createElement(PlayListContext, {
        parts: { name: 'Projects', count: '4 of 23', accessibilityLabel: 'Playing from Projects, 4 of 23' },
        caption: 'Preview · not on the wall',
      }),
    );
    const all = texts(container);
    expect(all).toHaveLength(3);
    for (const text of all) {
      expect(text.getAttribute('data-font-scaling')).toBe('false');
      expect(text.getAttribute('data-line-height')).toBe('19.2');
    }
  });
});
