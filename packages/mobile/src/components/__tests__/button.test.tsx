// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Controls the resolved UI variant the Button branches on.
const ctrl = vi.hoisted(() => ({ variant: 'material' as 'material' | 'liquidGlass' }));

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
}));

// Paper Button → <button> exposing the props the test asserts on.
vi.mock('react-native-paper', () => ({
  Button: ({ children, mode, disabled }: { children?: ReactNode; mode?: string; disabled?: boolean }) =>
    createElement('button', { 'data-paper': 'true', 'data-mode': mode, disabled }, children),
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
    radii: { button: ctrl.variant === 'material' ? 20 : 10 },
    brandColors: { primary: '#6D28D9', primaryFill: '#6D28D9', onPrimary: '#FFFFFF', accent: '#FF8A3D' },
  }),
}));

import { Button } from '../Button';

describe('Button', () => {
  it('renders a Paper button on the Material variant', () => {
    ctrl.variant = 'material';
    const { container } = render(<Button title="Log" onPress={() => {}} />);
    const paper = container.querySelector('[data-paper]');
    expect(paper).not.toBeNull();
    expect(paper?.getAttribute('data-mode')).toBe('contained'); // filled → contained
    expect(container.querySelector('[data-pressable]')).toBeNull();
  });

  it('renders the Liquid Glass (PressableSurface) button on the Liquid Glass variant', () => {
    ctrl.variant = 'liquidGlass';
    const { container } = render(<Button title="Log" onPress={() => {}} />);
    expect(container.querySelector('[data-pressable]')).not.toBeNull();
    expect(container.querySelector('[data-paper]')).toBeNull();
  });
});
