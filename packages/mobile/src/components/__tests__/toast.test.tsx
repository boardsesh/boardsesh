// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Controls the resolved UI variant the Toast branches on.
const ctrl = vi.hoisted(() => ({
  variant: 'material' as 'material' | 'liquidGlass',
  colorScheme: 'light' as 'light' | 'dark',
  nativeTabBar: false,
  nativeBottomAccessoryAvailable: true,
  insetsBottom: 34,
  measuredTabContentInsetBottom: null as number | null,
  segments: ['(tabs)', 'climbs'] as readonly string[],
}));

type ViewMockProps = { children?: ReactNode; accessibilityRole?: string; pointerEvents?: string; style?: unknown };
vi.mock('react-native', () => ({
  View: ({ children, accessibilityRole, pointerEvents, style }: ViewMockProps) =>
    createElement(
      'div',
      {
        'data-view': 'true',
        'data-role': accessibilityRole ?? '',
        'data-pointer-events': pointerEvents ?? '',
        'data-style': JSON.stringify(style),
      },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, absoluteFill: {} },
  Platform: { OS: 'android' },
  PlatformColor: (color: string) => color,
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

vi.mock('expo-router', () => ({ useSegments: () => ctrl.segments }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: ctrl.insetsBottom, left: 0, right: 0 }),
}));
vi.mock('../../hooks/use-bottom-accessory', () => ({
  isBottomAccessoryAvailable: () => ctrl.nativeBottomAccessoryAvailable,
  useNativeTabBar: () => ctrl.nativeTabBar,
}));
vi.mock('../../lib/native-tab-content-inset-store', () => ({
  useNativeTabContentInsetBottom: () => ctrl.measuredTabContentInsetBottom,
}));

vi.mock('../Text', () => ({
  Text: ({ children, color }: { children?: ReactNode; color?: string }) =>
    createElement('span', { 'data-text': 'true', 'data-color': color ?? '' }, children),
}));
vi.mock('../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-color': color ?? '' }),
}));
vi.mock('../../theme/colors', () => ({
  withAlpha: (color: string, alpha: number) => `${color}|${alpha}`,
  // Encode both args so tests can assert the variant colour (foreground) and the
  // surface (background) both reach blendOpaque — i.e. the colour-selection logic.
  blendOpaque: (foreground: string, background: string, alpha: number) => `${foreground}|${background}|${alpha}`,
}));
vi.mock('../../theme/tokens', () => ({ borderRadius: { full: 999 }, spacing: { 2: 8, 3: 12, 4: 16 } }));
vi.mock('../../theme/layout', () => ({
  MATERIAL_ACTIVE_CONTEXT_BAR_HEIGHT: 48,
  MATERIAL_TAB_BAR_HEIGHT: 80,
  TAB_BAR_HEIGHT: 49,
  // Production semantics: glassSize.hero(56) + TOOLBAR_GAP_ABOVE_TABBAR(10).
  TOOLBAR_RESERVE: 66,
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => {
    const brandColorsByScheme = {
      light: { success: '#047857', error: '#C81E1E', primary: '#6D28D9', warning: '#B45309' },
      dark: { success: '#34D399', error: '#F87171', primary: '#A78BFA', warning: '#FBBF24' },
    } as const;
    const systemColorsByVariant = {
      material: {
        light: { secondaryBackground: '#FFFFFF', label: '#16111F' },
        dark: { secondaryBackground: '#221A33', label: '#F5F2FB' },
      },
      liquidGlass: {
        light: { secondaryBackground: '#FFFFFF', label: '#16111F' },
        dark: { secondaryBackground: '#181225', label: '#F5F2FB' },
      },
    } as const;
    return {
      variant: ctrl.variant,
      colorScheme: ctrl.colorScheme,
      brandColors: brandColorsByScheme[ctrl.colorScheme],
      systemColors: systemColorsByVariant[ctrl.variant][ctrl.colorScheme],
    };
  },
}));

import { Toast } from '../Toast';
import { TAB_BAR_HEIGHT, TOOLBAR_RESERVE } from '../../theme/layout';
import { spacing } from '../../theme/tokens';

const toast = { id: 't1', message: 'Saved tick', variant: 'success' as const, duration: 3000 };
// The IN-TAB inset without BottomAccessory (root 34 + bar 49), as published by
// NativeTabContentInsetProbe. Realistic arithmetic, INFERRED not device-verified.
const NATIVE_TAB_ONLY_INSET = 34 + TAB_BAR_HEIGHT;

type HexChannels = [red: number, green: number, blue: number];

function parseHex(color: string): HexChannels {
  const channels = color.replace('#', '');
  return [
    Number.parseInt(channels.slice(0, 2), 16),
    Number.parseInt(channels.slice(2, 4), 16),
    Number.parseInt(channels.slice(4, 6), 16),
  ];
}

function relativeLuminance(color: string): number {
  const linearChannels = parseHex(color).map((channel) => {
    const normalizedChannel = channel / 255;
    return normalizedChannel <= 0.03928 ? normalizedChannel / 12.92 : ((normalizedChannel + 0.055) / 1.055) ** 2.4;
  });
  return linearChannels[0]! * 0.2126 + linearChannels[1]! * 0.7152 + linearChannels[2]! * 0.0722;
}

function contrastRatio(firstColor: string, secondColor: string): number {
  const firstLuminance = relativeLuminance(firstColor);
  const secondLuminance = relativeLuminance(secondColor);
  const lighterLuminance = Math.max(firstLuminance, secondLuminance);
  const darkerLuminance = Math.min(firstLuminance, secondLuminance);
  return (lighterLuminance + 0.05) / (darkerLuminance + 0.05);
}

describe('Toast', () => {
  beforeEach(() => {
    ctrl.variant = 'material';
    ctrl.colorScheme = 'light';
    ctrl.nativeTabBar = false;
    ctrl.nativeBottomAccessoryAvailable = true;
    ctrl.insetsBottom = 34;
    ctrl.measuredTabContentInsetBottom = null;
    ctrl.segments = ['(tabs)', 'climbs'];
  });

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
    expect(snackbar?.getAttribute('data-bg')).toBe('#047857|#FFFFFF|0.15');
    expect(container.querySelector('[data-icon="success"]')?.getAttribute('data-color')).toBe('#047857');
    expect(container.querySelector('[data-text]')?.getAttribute('data-color')).toBe('#16111F');
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

  it.each([
    { uiVariant: 'material' as const, colorScheme: 'light' as const },
    { uiVariant: 'material' as const, colorScheme: 'dark' as const },
    { uiVariant: 'liquidGlass' as const, colorScheme: 'light' as const },
    { uiVariant: 'liquidGlass' as const, colorScheme: 'dark' as const },
  ])(
    'uses an adaptive label while preserving every icon + tint on $uiVariant in $colorScheme mode',
    ({ uiVariant, colorScheme }) => {
      ctrl.variant = uiVariant;
      ctrl.colorScheme = colorScheme;
      const expectedPalette =
        colorScheme === 'dark'
          ? { success: '#34D399', error: '#F87171', warning: '#FBBF24', info: '#A78BFA' }
          : { success: '#047857', error: '#C81E1E', warning: '#B45309', info: '#6D28D9' };
      const expectedLabel = colorScheme === 'dark' ? '#F5F2FB' : '#16111F';
      const expectedSurface =
        uiVariant === 'material'
          ? colorScheme === 'dark'
            ? '#221A33'
            : '#FFFFFF'
          : colorScheme === 'dark'
            ? '#181225'
            : '#FFFFFF';
      const tintAlpha = colorScheme === 'dark' ? 0.24 : 0.15;
      const cases = [
        { variant: 'success' as const, icon: 'success' },
        { variant: 'error' as const, icon: 'error' },
        { variant: 'warning' as const, icon: 'warning' },
        { variant: 'info' as const, icon: 'info' },
      ];

      for (const { variant, icon } of cases) {
        const expectedVariantColor = expectedPalette[variant];
        const { container } = render(
          <Toast toast={{ id: variant, message: 'msg', variant, duration: 3000 }} onDismiss={() => {}} />,
        );
        expect(container.querySelector(`[data-icon="${icon}"]`)?.getAttribute('data-color')).toBe(expectedVariantColor);
        expect(container.querySelector('[data-text]')?.getAttribute('data-color')).toBe(expectedLabel);
        if (uiVariant === 'material') {
          expect(container.querySelector('[data-paper-snackbar]')?.getAttribute('data-bg')).toBe(
            `${expectedVariantColor}|${expectedSurface}|${tintAlpha}`,
          );
        } else {
          expect(container.querySelector('[data-view][data-pointer-events="none"]')?.getAttribute('data-style')).toBe(
            JSON.stringify([{}, { backgroundColor: `${expectedVariantColor}|${tintAlpha}` }]),
          );
        }
      }
    },
  );

  it('keeps toast message contrast at WCAG AA across real Material and Android Liquid Glass tokens', async () => {
    const { androidFallbackColors, blendOpaque, brandColors, brandColorsDark, materialSurfaces } =
      await vi.importActual<typeof import('../../theme/colors')>('../../theme/colors');
    const schemes = ['light', 'dark'] as const;
    const toastSurfaces = ['material', 'androidLiquidGlass'] as const;
    const variants = [
      { variant: 'success', colorKey: 'success' },
      { variant: 'error', colorKey: 'error' },
      { variant: 'info', colorKey: 'primary' },
      { variant: 'warning', colorKey: 'warning' },
    ] as const;

    for (const scheme of schemes) {
      const palette = scheme === 'dark' ? brandColorsDark : brandColors;
      const tintAlpha = scheme === 'dark' ? 0.24 : 0.15;
      for (const toastSurface of toastSurfaces) {
        const surfaceTokens = toastSurface === 'material' ? materialSurfaces[scheme] : androidFallbackColors[scheme];
        for (const { variant, colorKey } of variants) {
          const composedBackground = blendOpaque(palette[colorKey], surfaceTokens.secondaryBackground, tintAlpha);
          expect(
            contrastRatio(surfaceTokens.label, composedBackground),
            `${scheme} ${toastSurface} ${variant} toast`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
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
    expect(container.querySelector('[data-icon="success"]')?.getAttribute('data-color')).toBe('#047857');
    expect(container.querySelector('[data-text]')?.getAttribute('data-color')).toBe('#16111F');
    expect(container.textContent).toContain('Saved tick');
    expect(container.querySelector('[data-paper-snackbar]')).toBeNull();
  });

  it('preserves explicit tab and queue reserves on the Liquid Glass JS fallback', () => {
    ctrl.variant = 'liquidGlass';
    const { container } = render(<Toast toast={toast} onDismiss={() => {}} />);
    const expectedBottom = 34 + TAB_BAR_HEIGHT + TOOLBAR_RESERVE + spacing[2];
    expect(container.querySelector('[data-animated]')?.getAttribute('data-style')).toContain(
      `"bottom":${expectedBottom}`,
    );
  });

  it('does not add native tab or accessory chrome to the measured 139pt in-tab inset (#3973)', () => {
    ctrl.variant = 'liquidGlass';
    ctrl.nativeTabBar = true;
    // Toast samples the ROOT inset (34); the 139 accessory inset arrives as the
    // in-tab measurement from NativeTabContentInsetProbe.
    ctrl.insetsBottom = 34;
    ctrl.measuredTabContentInsetBottom = 139;
    const { container } = render(<Toast toast={toast} onDismiss={() => {}} />);
    // 139 already includes the home indicator, native tab bar, and accessory;
    // Toast adds only its 8pt visual gap.
    expect(container.querySelector('[data-animated]')?.getAttribute('data-style')).toContain('"bottom":147');
  });

  it('reconstructs the native bar from the root inset before the probe publishes', () => {
    ctrl.variant = 'liquidGlass';
    ctrl.nativeTabBar = true;
    ctrl.insetsBottom = 34;
    ctrl.measuredTabContentInsetBottom = null;
    const { container } = render(<Toast toast={toast} onDismiss={() => {}} />);
    // Pre-measurement frames: root (34) + TAB_BAR_HEIGHT + gap. The accessory
    // cannot be reconstructed up here (no climb state above QueueProvider), so a
    // pre-publish toast may briefly sit behind the accessory platter — see the
    // useToastBottomOffset docblock. The accessory is available in this state, so
    // no JS queue reserve either.
    const expectedBottom = 34 + TAB_BAR_HEIGHT + spacing[2];
    expect(container.querySelector('[data-animated]')?.getAttribute('data-style')).toContain(
      `"bottom":${expectedBottom}`,
    );
  });

  it('clears the JS queue bar when NativeTabs cannot mount a BottomAccessory', () => {
    ctrl.variant = 'liquidGlass';
    ctrl.nativeTabBar = true;
    ctrl.nativeBottomAccessoryAvailable = false;
    ctrl.insetsBottom = 34;
    ctrl.measuredTabContentInsetBottom = NATIVE_TAB_ONLY_INSET;
    const { container } = render(<Toast toast={toast} onDismiss={() => {}} />);
    const expectedBottom = NATIVE_TAB_ONLY_INSET + TOOLBAR_RESERVE + spacing[2];
    // The in-tab measurement owns the tab-bar clearance, while the unavailable
    // BottomAccessory falls back to the JS queue tray. Do not add TAB_BAR_HEIGHT
    // a second time.
    expect(container.querySelector('[data-animated]')?.getAttribute('data-style')).toContain(
      `"bottom":${expectedBottom}`,
    );
  });

  it('does not reserve the JS queue bar on a pushed NativeTabs route', () => {
    ctrl.variant = 'liquidGlass';
    ctrl.nativeTabBar = true;
    ctrl.nativeBottomAccessoryAvailable = false;
    ctrl.insetsBottom = 34;
    ctrl.measuredTabContentInsetBottom = NATIVE_TAB_ONLY_INSET;
    ctrl.segments = ['(tabs)', 'home', 'session', '[sessionId]'];
    const { container } = render(<Toast toast={toast} onDismiss={() => {}} />);
    const expectedBottom = NATIVE_TAB_ONLY_INSET + spacing[2];
    expect(container.querySelector('[data-animated]')?.getAttribute('data-style')).toContain(
      `"bottom":${expectedBottom}`,
    );
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
