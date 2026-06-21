// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Controls the resolved UI variant the Badge branches on.
const ctrl = vi.hoisted(() => ({ variant: 'material' as 'material' | 'liquidGlass' }));

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-view': 'true' }, children),
}));

// Reanimated Animated.View (Liquid Glass path) → a plain div.
vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-animated': 'true' }, children),
  },
  FadeIn: { springify: () => ({ damping: () => ({ stiffness: () => ({}) }) }) },
  FadeOut: { duration: () => ({}) },
}));

// Paper Badge → <span> exposing the props the test asserts on.
vi.mock('react-native-paper', () => ({
  Badge: ({ children, visible, size }: { children?: ReactNode; visible?: boolean; size?: number }) =>
    createElement(
      'span',
      { 'data-paper-badge': 'true', 'data-visible': String(visible), 'data-size': String(size) },
      children,
    ),
}));

vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));
vi.mock('../../theme/ios-colors', () => ({ iosSystemColors: { systemRed: '#FF3B30', white: '#FFFFFF' } }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ variant: ctrl.variant }),
}));

import { Badge } from '../Badge';

describe('Badge', () => {
  it('renders a Paper Badge with the count on the Material variant', () => {
    ctrl.variant = 'material';
    const { container } = render(<Badge count={3} />);
    const paper = container.querySelector('[data-paper-badge]');
    expect(paper).not.toBeNull();
    expect(paper?.textContent).toBe('3');
    expect(container.querySelector('[data-animated]')).toBeNull();
  });

  it('renders a dot (no count text) when count is zero on the Material variant', () => {
    ctrl.variant = 'material';
    const { container } = render(<Badge count={0} />);
    const paper = container.querySelector('[data-paper-badge]');
    expect(paper).not.toBeNull();
    expect(paper?.textContent).toBe('');
  });

  it('caps the displayed count at 99+ on the Material variant', () => {
    ctrl.variant = 'material';
    const { container } = render(<Badge count={150} />);
    expect(container.querySelector('[data-paper-badge]')?.textContent).toBe('99+');
  });

  it('renders the animated Liquid Glass badge on the Liquid Glass variant', () => {
    ctrl.variant = 'liquidGlass';
    const { container } = render(<Badge count={3} />);
    expect(container.querySelector('[data-animated]')).not.toBeNull();
    expect(container.querySelector('[data-paper-badge]')).toBeNull();
  });
});
