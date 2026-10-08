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
    View: ({ children, style }: { children?: ReactNode; style?: Array<{ backgroundColor?: string }> }) =>
      createElement('div', { 'data-animated': 'true', 'data-background': style?.[1]?.backgroundColor ?? '' }, children),
  },
  FadeIn: { springify: () => ({ damping: () => ({ stiffness: () => ({}) }) }) },
  FadeOut: { duration: () => ({}) },
}));

// Paper Badge → <span> exposing the props the test asserts on.
vi.mock('react-native-paper', () => ({
  Badge: ({
    children,
    visible,
    size,
    style,
  }: {
    children?: ReactNode;
    visible?: boolean;
    size?: number;
    style?: { backgroundColor?: string };
  }) =>
    createElement(
      'span',
      {
        'data-paper-badge': 'true',
        'data-visible': String(visible),
        'data-size': String(size),
        'data-background': style?.backgroundColor ?? '',
      },
      children,
    ),
}));

vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));
vi.mock('../../theme/ios-colors', () => ({ iosSystemColors: { white: '#FFFFFF' } }));
// A sentinel error colour, distinct from the static #FF3B30, so the assertions
// prove the badge reads the theme's adaptive error role.
const THEME_ERROR = 'theme-error-role';
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ variant: ctrl.variant, systemColors: { error: THEME_ERROR } }),
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

  it('fills with the theme error role by default on both variants', () => {
    ctrl.variant = 'material';
    const material = render(<Badge count={3} />);
    expect(material.container.querySelector('[data-paper-badge]')?.getAttribute('data-background')).toBe(THEME_ERROR);
    material.unmount();

    ctrl.variant = 'liquidGlass';
    const glass = render(<Badge count={3} />);
    expect(glass.container.querySelector('[data-animated]')?.getAttribute('data-background')).toBe(THEME_ERROR);
  });

  it('keeps an explicit colour over the theme error role', () => {
    ctrl.variant = 'liquidGlass';
    const { container } = render(<Badge count={3} color="#00AA00" />);
    expect(container.querySelector('[data-animated]')?.getAttribute('data-background')).toBe('#00AA00');
  });
});
