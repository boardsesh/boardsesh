// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Controls the resolved UI variant the button branches on. The glass-path tests
// below all run on the Liquid Glass variant; a dedicated test flips it to material.
const ctrl = vi.hoisted(() => ({ variant: 'liquidGlass' as 'material' | 'liquidGlass' }));

// Minimal RN surface: View → div, StyleSheet stubs the helpers the button reads.
vi.mock('react-native', () => ({
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('div', { 'data-bg': readBackgroundColor(style) }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {}, hairlineWidth: 1 },
}));

function readBackgroundColor(style: unknown): string {
  if (Array.isArray(style)) {
    for (let index = style.length - 1; index >= 0; index -= 1) {
      const color = readBackgroundColor(style[index]);
      if (color) return color;
    }
    return '';
  }
  if (style != null && typeof style === 'object' && 'backgroundColor' in style) {
    const { backgroundColor } = style as { backgroundColor?: unknown };
    return typeof backgroundColor === 'string' ? backgroundColor : '';
  }
  return '';
}

// Paper IconButton → DOM node exposing the props the material test asserts on.
vi.mock('react-native-paper', () => ({
  IconButton: ({
    icon,
    onPress,
    disabled,
    accessibilityLabel,
  }: {
    icon?: string;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) =>
    createElement('button', {
      'data-paper-icon': icon,
      onClick: onPress,
      disabled,
      'data-label': accessibilityLabel,
    }),
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: number) => ({ value }),
  withTiming: (value: number) => value,
}));

// GlassSurface degrades elsewhere; here we only care that it received a tint.
vi.mock('../GlassSurface', () => ({
  GlassSurface: ({ tintColor }: { tintColor?: string }) =>
    createElement('div', { 'data-glass': 'true', 'data-tint': tintColor ?? '' }),
}));

type PressMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  onPressOut?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
};
vi.mock('../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    onPressOut,
    onLongPress,
    disabled,
    accessibilityLabel,
    accessibilityHint,
  }: PressMockProps) =>
    createElement(
      'button',
      {
        onClick: onPress,
        onMouseUp: onPressOut,
        onDoubleClick: onLongPress,
        disabled,
        'data-label': accessibilityLabel,
        'data-hint': accessibilityHint ?? '',
      },
      children,
    ),
}));

vi.mock('../Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));

vi.mock('../Text', () => ({
  Text: ({
    children,
    color,
    maxFontSizeMultiplier,
  }: {
    children?: ReactNode;
    color?: string;
    maxFontSizeMultiplier?: number;
  }) =>
    createElement(
      'span',
      {
        'data-text': 'true',
        'data-color': color ?? '',
        'data-max-font-size-multiplier': maxFontSizeMultiplier == null ? '' : String(maxFontSizeMultiplier),
      },
      children,
    ),
}));

// GlassIconButton reads only `variant` from the theme; its count badge is a
// white-text FILL drawn from the static `brandColors` import (mocked below), so
// the theme mock deliberately omits brandColors rather than carry a dead field.
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ variant: ctrl.variant }),
}));

// The material branch maps the semantic name to its MDI glyph via iconMap.
vi.mock('../icon-map', () => ({
  iconMap: {
    search: { ios: 'magnifyingglass', android: 'magnify' },
    filter: { ios: 'line.3.horizontal.decrease', android: 'filter-variant' },
    tick: { ios: 'checkmark.circle.fill', android: 'check-circle' },
    close: { ios: 'xmark', android: 'close' },
  },
}));

// Live mock: the badge fill reads `brandColors.primary` from this static import.
vi.mock('../../theme/colors', () => ({ brandColors: { primary: '#6D28D9' } }));
vi.mock('../../theme/ios-colors', () => ({ iosSystemColors: { white: '#FFFFFF' } }));
vi.mock('../../theme/animations', () => ({ timing: { fast: 150 } }));
vi.mock('../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => false }));

import { GlassIconButton } from '../GlassIconButton';

const base = { iconColor: '#000', fallbackColor: '#fff', onPress: () => {}, accessibilityLabel: 'Act' };

describe('GlassIconButton (Liquid Glass variant)', () => {
  beforeEach(() => {
    ctrl.variant = 'liquidGlass';
  });

  it('renders the icon and fires onPress', () => {
    const onPress = vi.fn();
    const { getByRole, container } = render(<GlassIconButton {...base} iconName="search" onPress={onPress} />);
    expect(container.querySelector('[data-icon="search"]')).not.toBeNull();
    fireEvent.click(getByRole('button'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('shows a badge only when badgeCount > 0', () => {
    const { container, rerender } = render(<GlassIconButton {...base} iconName="filter" badgeCount={3} />);
    expect(container.textContent).toContain('3');
    rerender(<GlassIconButton {...base} iconName="filter" badgeCount={0} />);
    expect(container.textContent).not.toContain('3');
  });

  it('uses the default violet badge with white text', () => {
    const { container } = render(<GlassIconButton {...base} iconName="filter" badgeCount={3} />);
    expect(container.querySelector('[data-bg="#6D28D9"]')).not.toBeNull();
    expect(container.querySelector('[data-text]')?.getAttribute('data-color')).toBe('#FFFFFF');
  });

  it('allows callers to override badge colors', () => {
    const { container } = render(
      <GlassIconButton
        {...base}
        iconName="filter"
        badgeCount={3}
        badgeBackgroundColor="#FFFFFF"
        badgeTextColor="#6D28D9"
      />,
    );
    expect(container.querySelector('[data-bg="#FFFFFF"]')).not.toBeNull();
    expect(container.querySelector('[data-text]')?.getAttribute('data-color')).toBe('#6D28D9');
  });

  it('clamps large badges and caps badge text scaling', () => {
    const { container } = render(<GlassIconButton {...base} iconName="filter" badgeCount={150} />);
    const badgeText = container.querySelector('[data-text]');
    expect(badgeText?.textContent).toBe('99+');
    expect(badgeText?.getAttribute('data-max-font-size-multiplier')).toBe('1');
  });

  it('forwards accessibilityLabel and accessibilityHint', () => {
    const { getByRole } = render(
      <GlassIconButton
        {...base}
        iconName="search"
        accessibilityLabel="Open search"
        accessibilityHint="Opens controls"
      />,
    );
    const button = getByRole('button');
    expect(button.getAttribute('data-label')).toBe('Open search');
    expect(button.getAttribute('data-hint')).toBe('Opens controls');
  });

  it('renders both glyphs when a morph target is set (cross-fade, not swap)', () => {
    const { container } = render(<GlassIconButton {...base} iconName="search" secondaryIconName="close" active />);
    expect(container.querySelector('[data-icon="search"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="close"]')).not.toBeNull();
  });

  it('passes disabled through to the pressable', () => {
    const { getByRole } = render(<GlassIconButton {...base} iconName="search" disabled />);
    expect((getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('suppresses onPress immediately after onLongPress', () => {
    const onPress = vi.fn();
    const onLongPress = vi.fn();
    const { getByRole } = render(
      <GlassIconButton {...base} iconName="filter" onPress={onPress} onLongPress={onLongPress} />,
    );
    const button = getByRole('button');
    fireEvent.doubleClick(button);
    fireEvent.click(button);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('clears long-press suppression after the release cycle', () => {
    vi.useFakeTimers();
    const onPress = vi.fn();
    const onLongPress = vi.fn();
    const { getByRole } = render(
      <GlassIconButton {...base} iconName="filter" onPress={onPress} onLongPress={onLongPress} />,
    );
    const button = getByRole('button');

    fireEvent.doubleClick(button);
    fireEvent.mouseUp(button);
    fireEvent.click(button);
    expect(onPress).not.toHaveBeenCalled();

    vi.runAllTimers();
    fireEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('GlassIconButton (Material variant)', () => {
  beforeEach(() => {
    ctrl.variant = 'material';
  });

  it('renders a Paper IconButton with the MDI glyph and no glass surface', () => {
    const { container } = render(<GlassIconButton {...base} iconName="search" />);
    const paper = container.querySelector('[data-paper-icon]');
    expect(paper).not.toBeNull();
    expect(paper?.getAttribute('data-paper-icon')).toBe('magnify'); // search → MDI magnify
    expect(container.querySelector('[data-glass]')).toBeNull();
  });

  it('fires onPress and forwards accessibilityLabel + disabled', () => {
    const onPress = vi.fn();
    const { getByRole } = render(
      <GlassIconButton {...base} iconName="search" onPress={onPress} accessibilityLabel="Open search" />,
    );
    const button = getByRole('button');
    expect(button.getAttribute('data-label')).toBe('Open search');
    fireEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('overlays a clamped badge only when badgeCount > 0', () => {
    const { container, rerender } = render(<GlassIconButton {...base} iconName="filter" badgeCount={3} />);
    expect(container.querySelector('[data-text]')?.textContent).toBe('3');
    rerender(<GlassIconButton {...base} iconName="filter" badgeCount={150} />);
    expect(container.querySelector('[data-text]')?.textContent).toBe('99+');
    rerender(<GlassIconButton {...base} iconName="filter" badgeCount={0} />);
    expect(container.querySelector('[data-text]')).toBeNull();
  });

  it('passes disabled through to the Paper IconButton', () => {
    const { getByRole } = render(<GlassIconButton {...base} iconName="search" disabled />);
    expect((getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });
});
