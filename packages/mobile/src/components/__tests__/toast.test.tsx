// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Controls the resolved UI variant the Toast branches on.
const ctrl = vi.hoisted(() => ({ variant: 'material' as 'material' | 'liquidGlass' }));

type ViewMockProps = { children?: ReactNode; accessibilityRole?: string };
vi.mock('react-native', () => ({
  View: ({ children, accessibilityRole }: ViewMockProps) =>
    createElement('div', { 'data-view': 'true', 'data-role': accessibilityRole ?? '' }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {} },
}));

// Reanimated Animated.View → div exposing accessibility props (glass path).
vi.mock('react-native-reanimated', () => ({
  default: {
    View: ({
      children,
      accessibilityRole,
      style,
    }: {
      children?: ReactNode;
      accessibilityRole?: string;
      style?: unknown;
    }) =>
      createElement(
        'div',
        { 'data-animated': 'true', 'data-role': accessibilityRole ?? '', 'data-style': JSON.stringify(style) },
        children,
      ),
  },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));

// Paper Snackbar → div exposing visible/duration/children + onDismiss.
type SnackbarMockProps = {
  visible?: boolean;
  duration?: number;
  onDismiss?: () => void;
  children?: ReactNode;
  wrapperStyle?: unknown;
  style?: { backgroundColor?: string };
};
vi.mock('react-native-paper', () => ({
  Snackbar: ({ visible, duration, onDismiss, children, wrapperStyle, style }: SnackbarMockProps) =>
    createElement(
      'div',
      {
        'data-paper-snackbar': 'true',
        'data-visible': visible ? 'true' : 'false',
        'data-duration': String(duration ?? ''),
        'data-wrapper-style': JSON.stringify(wrapperStyle),
        'data-bg': style?.backgroundColor ?? '',
        onClick: onDismiss,
      },
      children,
    ),
}));

vi.mock('expo-router', () => ({ useSegments: () => ['(tabs)', 'climbs'] }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

vi.mock('../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-text': 'true' }, children),
}));
vi.mock('../Icon', () => ({ Icon: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('../../theme/colors', () => ({
  // Real light-scheme brandColors values (the component reads these from useTheme;
  // kept here in sync so the mock can't drift from the source palette).
  brandColors: { success: '#047857', error: '#C81E1E', primary: '#6D28D9', warning: '#B45309' },
  withAlpha: (color: string) => color,
  // Encode both args so tests can assert the variant colour (foreground) and the
  // surface (background) both reach blendOpaque — i.e. the colour-selection logic.
  blendOpaque: (foreground: string, background: string) => `${foreground}|${background}`,
}));
vi.mock('../../theme/tokens', () => ({ borderRadius: { full: 999 }, spacing: { 2: 8, 3: 12, 4: 16 } }));
vi.mock('../../theme/layout', () => ({
  MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT: 48,
  MATERIAL_TAB_BAR_HEIGHT: 80,
  TAB_BAR_HEIGHT: 49,
  TOOLBAR_RESERVE: 56,
}));
vi.mock('../../lib/route-segments', () => ({ isTabsRoute: () => true }));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: ctrl.variant,
    colorScheme: 'light',
    brandColors: { success: '#047857', error: '#C81E1E', primary: '#6D28D9', warning: '#B45309' },
    systemColors: { secondaryBackground: '#EEE', label: '#000' },
  }),
}));

import { Toast } from '../Toast';

const toast = { id: 't1', message: 'Saved tick', variant: 'success' as const, duration: 3000 };

describe('Toast', () => {
  it('renders a Paper Snackbar on the Material variant', () => {
    ctrl.variant = 'material';
    const { container } = render(<Toast toast={toast} onDismiss={() => {}} />);
    const snackbar = container.querySelector('[data-paper-snackbar]');
    expect(snackbar).not.toBeNull();
    expect(snackbar?.getAttribute('data-visible')).toBe('true');
    expect(snackbar?.getAttribute('data-duration')).toBe('3000'); // duration mapped through
    expect(snackbar?.textContent).toContain('Saved tick'); // message mapped through
    // Variant cue carries through: leading icon, brand-tinted surface, alert role.
    expect(container.querySelector('[data-icon="success"]')).not.toBeNull();
    // blendOpaque(config.color, secondaryBackground): success → brand success hue.
    expect(snackbar?.getAttribute('data-bg')).toBe('#047857|#EEE');
    expect(container.querySelector('[data-view][data-role="alert"]')).not.toBeNull();
    // The glass animated pill must not render on Material.
    expect(container.querySelector('[data-animated]')).toBeNull();
  });

  it('positions Material toasts above the docked climb bar and tab bar', () => {
    ctrl.variant = 'material';
    const { container } = render(<Toast toast={toast} onDismiss={() => {}} />);
    // insets.bottom(34) + MATERIAL_TAB_BAR_HEIGHT(80) + active-context bar(48) +
    // spacing[2](8) = 170. The tab-bar term is the taller M3 80dp nav bar, not the
    // 49pt iOS bar, so the Material snackbar clears the nav bar rather than tucking
    // under it.
    expect(container.querySelector('[data-paper-snackbar]')?.getAttribute('data-wrapper-style')).toContain(
      '"bottom":170',
    );
  });

  it('selects the matching icon + tint per variant on the Material variant', () => {
    ctrl.variant = 'material';
    const cases = [
      { variant: 'error' as const, icon: 'error', color: '#C81E1E' },
      { variant: 'warning' as const, icon: 'warning', color: '#B45309' },
      { variant: 'info' as const, icon: 'info', color: '#6D28D9' },
    ];
    for (const { variant, icon, color } of cases) {
      const { container } = render(
        <Toast toast={{ id: variant, message: 'msg', variant, duration: 3000 }} onDismiss={() => {}} />,
      );
      expect(container.querySelector(`[data-icon="${icon}"]`)).not.toBeNull();
      expect(container.querySelector('[data-paper-snackbar]')?.getAttribute('data-bg')).toBe(`${color}|#EEE`);
    }
  });

  it('routes Paper onDismiss to onDismiss(toast.id)', () => {
    ctrl.variant = 'material';
    const onDismiss = vi.fn();
    const { container } = render(<Toast toast={toast} onDismiss={onDismiss} />);
    (container.querySelector('[data-paper-snackbar]') as HTMLElement).click();
    expect(onDismiss).toHaveBeenCalledWith('t1');
  });

  it('renders the Liquid Glass animated pill on the Liquid Glass variant', () => {
    ctrl.variant = 'liquidGlass';
    const { container } = render(<Toast toast={toast} onDismiss={() => {}} />);
    const animated = container.querySelector('[data-animated]');
    expect(animated).not.toBeNull();
    expect(animated?.getAttribute('data-role')).toBe('alert');
    expect(container.querySelector('[data-icon="success"]')).not.toBeNull();
    expect(container.textContent).toContain('Saved tick');
    expect(container.querySelector('[data-paper-snackbar]')).toBeNull();
  });

  it('positions Liquid Glass toasts above the floating toolbar reserve', () => {
    ctrl.variant = 'liquidGlass';
    const { container } = render(<Toast toast={toast} onDismiss={() => {}} />);
    expect(container.querySelector('[data-animated]')?.getAttribute('data-style')).toContain('"bottom":147');
  });

  it('auto-dismisses via timer on the Liquid Glass variant', () => {
    vi.useFakeTimers();
    ctrl.variant = 'liquidGlass';
    const onDismiss = vi.fn();
    render(<Toast toast={toast} onDismiss={onDismiss} />);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(onDismiss).toHaveBeenCalledWith('t1');
    vi.useRealTimers();
  });
});
