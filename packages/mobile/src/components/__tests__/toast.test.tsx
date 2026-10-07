// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { computeBottomChromeMetrics, type BottomChromeInputs } from '../../hooks/bottom-chrome-metrics';
import type { BottomChromeMetrics } from '../../hooks/bottom-chrome-metrics';

// Controls the resolved UI variant the Toast branches on.
const ctrl = vi.hoisted(() => ({
  variant: 'material' as 'material' | 'liquidGlass',
  colorScheme: 'light' as 'light' | 'dark',
  // What BottomChromeMetricsProvider would publish; each test builds it with
  // the real computeBottomChromeMetrics so the asserted offsets are the ones a
  // device gets.
  metrics: null as BottomChromeMetrics | null,
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

vi.mock('../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => {
    if (!ctrl.metrics) throw new Error('test did not set ctrl.metrics');
    return ctrl.metrics;
  },
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

const toast = { id: 't1', message: 'Saved tick', variant: 'success' as const, duration: 3000 };

// A top-level tab with no climb on the wall, root inset 34 (Face ID iPhone; the
// same number stands in for an Android gesture bar so the cases compare).
const BASE_INPUTS: BottomChromeInputs = {
  uiVariant: 'material',
  usesNativeTabBar: false,
  insetsBottom: 34,
  insideTabs: true,
  onAccessorySurface: true,
  hasCurrentClimb: false,
  nativeAccessoryPresented: false,
};

function setChrome(overrides: Partial<BottomChromeInputs> = {}) {
  ctrl.metrics = computeBottomChromeMetrics({ ...BASE_INPUTS, uiVariant: ctrl.variant, ...overrides });
}

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

/** The `bottom` the toast resolved to on either variant, as a number. */
function readToastBottom(container: HTMLElement): number {
  const style =
    container.querySelector('[data-paper-snackbar]')?.getAttribute('data-wrapper-style') ??
    container.querySelector('[data-animated]')?.getAttribute('data-style') ??
    '';
  const match = /"bottom":(-?\d+(?:\.\d+)?)/.exec(style);
  if (!match) throw new Error(`no bottom in toast style: ${style}`);
  return Number(match[1]);
}

describe('Toast', () => {
  beforeEach(() => {
    ctrl.variant = 'material';
    ctrl.colorScheme = 'light';
    setChrome();
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

  // Offsets in pt a climber gets, root inset 34. Each one is the shared
  // floatingControlBottom plus the 8pt gap the queue snackbars leave, so a toast
  // and a snackbar never sit at different heights over the same chrome.
  it.each([
    {
      name: 'Material, no climb: clears the 80dp nav bar, reserves no queue bar',
      variant: 'material' as const,
      chrome: {},
      bottom: 34 + 80 + 8,
    },
    {
      name: 'Material, climb on the wall: also clears the 48dp queue bar',
      variant: 'material' as const,
      chrome: { hasCurrentClimb: true },
      bottom: 34 + 80 + 48 + 8,
    },
    {
      name: 'Material, pushed tab route: no queue bar there, so none reserved',
      variant: 'material' as const,
      chrome: { hasCurrentClimb: true, onAccessorySurface: false },
      bottom: 34 + 80 + 8,
    },
    {
      // Keyed on the bar actually rendered: the JS fallback bar is 80pt tall, not
      // the 49pt native one the old variant-keyed math assumed.
      name: 'Liquid Glass JS fallback, climb: 80pt JS bar + 66pt floating queue bar',
      variant: 'liquidGlass' as const,
      chrome: { hasCurrentClimb: true },
      bottom: 34 + 80 + 66 + 8,
    },
    {
      name: 'iOS 26 NativeTabs, no climb, measured 83pt in-tab inset',
      variant: 'liquidGlass' as const,
      chrome: { usesNativeTabBar: true, nativeAccessoryPresented: true, measuredTabContentInsetBottom: 83 },
      bottom: 83 + 8,
    },
    {
      name: 'iOS 26 NativeTabs, accessory up, measured 139pt (DEVICE_VERIFIED iPhone 17 Pro)',
      variant: 'liquidGlass' as const,
      chrome: {
        usesNativeTabBar: true,
        nativeAccessoryPresented: true,
        hasCurrentClimb: true,
        measuredTabContentInsetBottom: 139,
      },
      bottom: 139 + 8,
    },
    {
      name: 'iOS 26 NativeTabs, accessory up, before the probe publishes: still clears the platter',
      variant: 'liquidGlass' as const,
      chrome: { usesNativeTabBar: true, nativeAccessoryPresented: true, hasCurrentClimb: true },
      bottom: 34 + 49 + 56 + 8,
    },
    {
      name: 'Material, rest timer armed: lifts over the 54pt pill',
      variant: 'material' as const,
      chrome: { restTimerArmed: true },
      bottom: 34 + 80 + 54 + 8,
    },
    {
      name: 'off the tabs: home indicator + gap only, even with the timer armed',
      variant: 'material' as const,
      chrome: { insideTabs: false, onAccessorySurface: false, hasCurrentClimb: true, restTimerArmed: true },
      bottom: 34 + 8,
    },
    {
      name: 'connectivity banner showing: lifts over its measured height',
      variant: 'material' as const,
      chrome: { connectivityBannerHeight: 40 },
      bottom: 34 + 80 + 40 + 8,
    },
  ])('$name', ({ variant, chrome, bottom }) => {
    ctrl.variant = variant;
    setChrome(chrome);
    const { container } = render(<Toast toast={toast} onDismiss={() => {}} />);
    expect(readToastBottom(container)).toBe(bottom);
    expect(readToastBottom(container)).toBe(ctrl.metrics!.floatingControlBottom + 8);
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
