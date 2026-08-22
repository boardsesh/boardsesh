// @vitest-environment jsdom
// The viewfinder frame costs zero board pixels and zero gestures — which is the
// entire justification for putting it on the board at all — so that is what the
// assertions pin.
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type ViewMockProps = { children?: ReactNode; style?: unknown; pointerEvents?: string };
const styleAttr = (style: unknown) => JSON.stringify(style ?? null);

vi.mock('react-native', () => ({
  View: ({ children, style, pointerEvents }: ViewMockProps) =>
    createElement('div', { 'data-style': styleAttr(style), 'data-pointer-events': pointerEvents ?? '' }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));

vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children, style, pointerEvents }: ViewMockProps) =>
      createElement('div', { 'data-style': styleAttr(style), 'data-pointer-events': pointerEvents ?? '' }, children),
  },
  FadeIn: { duration: (ms: number) => ({ fadeIn: ms }) },
  useReducedMotion: () => false,
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { tertiaryLabel: '#8E8E93' } }),
}));
vi.mock('../../../theme/tokens', () => ({ spacing: { 2: 8 } }));

import { BrowseFrameOverlay } from '../BrowseFrameOverlay';

describe('BrowseFrameOverlay', () => {
  it('draws four corner brackets, not a box', () => {
    const { container } = render(createElement(BrowseFrameOverlay));
    const corners = [...container.querySelectorAll('div[data-style]')].slice(1);

    expect(corners).toHaveLength(4);
    // Each L has exactly two arms; a full border on any of them would read as a
    // frame around the art rather than a viewfinder over it.
    for (const corner of corners) {
      const style = corner.getAttribute('data-style') ?? '';
      const arms = ['borderTopWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderRightWidth'].filter((edge) =>
        style.includes(edge),
      );
      expect(arms).toHaveLength(2);
    }
  });

  it('never intercepts a touch — the board keeps its swipe, pinch and pan', () => {
    const { container } = render(createElement(BrowseFrameOverlay));
    const frame = container.querySelector('div[data-style]') as HTMLElement;

    expect(frame.getAttribute('data-pointer-events')).toBe('none');
  });

  it('floats over the board without taking layout', () => {
    const { container } = render(createElement(BrowseFrameOverlay));
    const style = (container.querySelector('div[data-style]') as HTMLElement).getAttribute('data-style') ?? '';

    expect(style).toContain('"position":"absolute"');
    // A SIBLING of the carousel, and RN zIndex only orders siblings — so this
    // paints above the carousel's whole subtree whatever CAROUSEL_LAYER_Z says
    // internally. Any positive value does that; what keeps it harmless is
    // pointerEvents="none" plus corner placement.
    expect(style).toContain('"zIndex":1');
  });

  it('carries the neutral stroke — the brand accent is fill-only and cannot line', () => {
    const { container } = render(createElement(BrowseFrameOverlay));
    const corner = [...container.querySelectorAll('div[data-style]')][1] as HTMLElement;

    expect(corner.getAttribute('data-style')).toContain('"borderColor":"#8E8E93"');
  });
});
