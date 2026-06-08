// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Controls the resolved UI variant the Button branches on.
const ctrl = vi.hoisted(() => ({
  variant: 'material' as 'material' | 'liquidGlass',
  primary: '#3366AA',
}));

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
}));

// Paper Button → <button> exposing the props the test asserts on.
vi.mock('react-native-paper', () => ({
  Button: ({
    children,
    mode,
    disabled,
    buttonColor,
    textColor,
  }: {
    children?: ReactNode;
    mode?: string;
    disabled?: boolean;
    buttonColor?: string;
    textColor?: string;
  }) =>
    createElement(
      'button',
      {
        'data-paper': 'true',
        'data-mode': mode,
        'data-button-color': buttonColor,
        'data-text-color': textColor,
        disabled,
      },
      children,
    ),
}));

// Glass-path deps — the PressableSurface fallback renders a plain div.
vi.mock('../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-pressable': 'true' }, children),
}));
vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));
vi.mock('../Icon', () => ({ Icon: () => createElement('i', null) }));
vi.mock('../icon-map', () => ({ iconMap: { tick: { ios: 'checkmark', android: 'check' } } }));
vi.mock('../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../../theme/colors', () => ({ brandColors: { primary: '#6D28D9' } }));
vi.mock('../../theme/ios-colors', () => ({ iosSystemColors: { white: '#FFFFFF' } }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: ctrl.variant,
    brandColors: { primary: ctrl.primary, primaryFill: ctrl.primary, onPrimary: '#FFFFFF', accent: '#FF8A3D' },
    radii: { button: ctrl.variant === 'material' ? 20 : 10 },
  }),
}));

import { Button } from '../Button';

describe('Button', () => {
  beforeEach(() => {
    ctrl.variant = 'material';
    ctrl.primary = '#3366AA';
  });

  it('renders a Paper button on the Material variant', () => {
    const { container } = render(<Button title="Log" onPress={() => {}} />);
    const paper = container.querySelector('[data-paper]');
    expect(paper).not.toBeNull();
    expect(paper?.getAttribute('data-mode')).toBe('contained'); // filled → contained
    expect(container.querySelector('[data-pressable]')).toBeNull();
  });

  it('uses the resolved theme primary for untinted Material buttons', () => {
    const { container } = render(<Button title="Log" onPress={() => {}} />);
    const paper = container.querySelector('[data-paper]');
    expect(paper?.getAttribute('data-button-color')).toBe('#3366AA');
  });

  it('honours an explicit Material button tint', () => {
    const { container } = render(<Button title="Log" onPress={() => {}} tintColor="#FF3B30" variant="outlined" />);
    const paper = container.querySelector('[data-paper]');
    expect(paper?.getAttribute('data-text-color')).toBe('#FF3B30');
  });

  it('renders the Liquid Glass (PressableSurface) button on the Liquid Glass variant', () => {
    ctrl.variant = 'liquidGlass';
    const { container } = render(<Button title="Log" onPress={() => {}} />);
    expect(container.querySelector('[data-pressable]')).not.toBeNull();
    expect(container.querySelector('[data-paper]')).toBeNull();
  });
});
