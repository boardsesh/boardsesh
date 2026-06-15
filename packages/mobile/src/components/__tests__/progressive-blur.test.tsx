// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Mutable so each test can exercise a resolved colour scheme.
const themeMock = vi.hoisted(() => ({ colorScheme: 'dark' as 'dark' | 'light' }));
// Mutable surface mode: 'blur'/'glass' = live iOS blur; 'material'/'solid' = the
// Android / Reduce-Transparency fade fallback.
const surfaceMock = vi.hoisted(() => ({ mode: 'blur' as 'glass' | 'blur' | 'material' | 'solid' }));

vi.mock('react-native', () => ({
  StyleSheet: { absoluteFill: {} },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));

// Render the mask + children so both the gradient mask and the blur are assertable
// (these vi.mocks take precedence over the global test-config aliases).
vi.mock('@react-native-masked-view/masked-view', () => ({
  default: ({ children, maskElement }: { children?: ReactNode; maskElement?: ReactNode }) =>
    createElement('div', { 'data-testid': 'masked-view' }, maskElement, children),
}));
vi.mock('@react-native-community/blur', () => ({
  BlurView: ({ blurType, blurAmount }: { blurType?: string; blurAmount?: number }) =>
    createElement('div', { 'data-testid': 'blur-view', 'data-blur-type': blurType, 'data-blur-amount': blurAmount }),
}));
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ colors, locations }: { colors?: readonly string[]; locations?: readonly number[] }) =>
    createElement('div', {
      'data-testid': 'mask-gradient',
      'data-colors': JSON.stringify(colors),
      'data-locations': JSON.stringify(locations),
    }),
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ colorScheme: themeMock.colorScheme }),
}));
vi.mock('../../hooks/use-effective-surface-mode', () => ({ useEffectiveSurfaceMode: () => surfaceMock.mode }));

import { ProgressiveBlur } from '../ProgressiveBlur';

describe('ProgressiveBlur', () => {
  afterEach(() => {
    themeMock.colorScheme = 'dark';
    surfaceMock.mode = 'blur';
  });

  it('masks a blur with a top→transparent gradient (full blur up top, clear at the bottom)', () => {
    const { container } = render(<ProgressiveBlur />);
    expect(container.querySelector('[data-testid="masked-view"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="blur-view"]')).not.toBeNull();
    const grad = container.querySelector('[data-testid="mask-gradient"]');
    const colors = JSON.parse(grad?.getAttribute('data-colors') ?? '[]') as string[];
    expect(colors[0]).toBe('#000000');
    expect(colors[colors.length - 1]).toBe('transparent');
  });

  it('uses the dark thin material when the resolved scheme is dark', () => {
    themeMock.colorScheme = 'dark';
    const { container } = render(<ProgressiveBlur />);
    expect(container.querySelector('[data-testid="blur-view"]')?.getAttribute('data-blur-type')).toBe(
      'thinMaterialDark',
    );
  });

  it('uses the light thin material when the resolved scheme is light (honours the in-app override)', () => {
    themeMock.colorScheme = 'light';
    const { container } = render(<ProgressiveBlur />);
    expect(container.querySelector('[data-testid="blur-view"]')?.getAttribute('data-blur-type')).toBe(
      'thinMaterialLight',
    );
  });

  const hasDarkScrim = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('[data-testid="mask-gradient"]')).some((gradient) =>
      (gradient.getAttribute('data-colors') ?? '').includes('rgba(0,0,0'),
    );

  it('lays a black scrim over the blur in dark mode (sinks the dynamic-island band to black)', () => {
    themeMock.colorScheme = 'dark';
    const { container } = render(<ProgressiveBlur />);
    expect(hasDarkScrim(container)).toBe(true);
  });

  it('omits the black scrim in light mode', () => {
    themeMock.colorScheme = 'light';
    const { container } = render(<ProgressiveBlur />);
    expect(hasDarkScrim(container)).toBe(false);
  });

  it('renders no live blur on the Material / Reduce-Transparency path — a scene-background fade instead', () => {
    surfaceMock.mode = 'material';
    const { container } = render(<ProgressiveBlur />);
    // No BlurView at all; just a themed opaque→transparent gradient.
    expect(container.querySelector('[data-testid="blur-view"]')).toBeNull();
    expect(container.querySelector('[data-testid="masked-view"]')).toBeNull();
    const gradient = container.querySelector('[data-testid="mask-gradient"]');
    const colors = JSON.parse(gradient?.getAttribute('data-colors') ?? '[]') as string[];
    expect(colors[0]).toBe('#000000'); // dark scene background (default colour scheme)
    expect(colors[colors.length - 1]).toBe('transparent');
  });
});
