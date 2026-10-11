// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Mutable so each test can exercise a resolved colour scheme.
const themeMock = vi.hoisted(() => ({ colorScheme: 'dark' as 'dark' | 'light' }));
// Mutable surface mode: 'blur'/'glass' = live iOS blur; 'material'/'solid' = the
// Android / Reduce-Transparency fade fallback.
const surfaceMock = vi.hoisted(() => ({ mode: 'blur' as 'glass' | 'blur' | 'material' | 'solid' }));

function flattenStyle(style: unknown): Record<string, unknown> {
  return Object.assign({}, ...[style].flat(10).filter(Boolean));
}

vi.mock('react-native', () => ({
  StyleSheet: { absoluteFill: {}, create: (styles: Record<string, unknown>) => styles },
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('div', { 'data-view-style': JSON.stringify(flattenStyle(style)) }, children),
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
  LinearGradient: ({
    colors,
    locations,
    style,
  }: {
    colors?: readonly string[];
    locations?: readonly number[];
    style?: unknown;
  }) => {
    const { height } = flattenStyle(style);
    return createElement('div', {
      'data-testid': 'mask-gradient',
      'data-colors': JSON.stringify(colors),
      'data-locations': JSON.stringify(locations),
      // Only a fade of a fixed length carries a height; a full-height one fills.
      'data-height': typeof height === 'number' ? String(height) : '',
    });
  },
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

  // The backdrop behind controls pinned under a bar: full strength behind them,
  // fading only along the lower edge. The default ramp would leave the lowest row
  // of controls, at the bottom of the blur, almost bare.
  describe('with a fadeLength (pinned-controls backdrop)', () => {
    const gradients = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('[data-testid="mask-gradient"]')).map((gradient) => ({
        colors: JSON.parse(gradient.getAttribute('data-colors') ?? '[]') as string[],
        locations: JSON.parse(gradient.getAttribute('data-locations') ?? '[]') as number[],
        height: gradient.getAttribute('data-height'),
        plateau: JSON.parse(gradient.previousElementSibling?.getAttribute('data-view-style') ?? '{}') as Record<
          string,
          unknown
        >,
      }));

    it('holds every blur layer at full strength, then fades each over the fade length', () => {
      themeMock.colorScheme = 'light';
      const { container } = render(<ProgressiveBlur layers={2} fadeLength={24} scrim={false} />);

      expect(container.querySelectorAll('[data-testid="blur-view"]')).toHaveLength(2);
      const masks = gradients(container);
      expect(masks).toHaveLength(2);
      for (const mask of masks) {
        // An opaque plateau that takes the height the fade leaves over...
        expect(mask.plateau).toMatchObject({ flex: 1, backgroundColor: '#000000' });
        // ...then a fade of exactly the asked length, in points, not a fraction.
        expect(mask.height).toBe('24');
        expect(mask.colors).toEqual(['#000000', 'transparent']);
      }
      // The first layer fades across the whole length; the next is gone halfway.
      expect(masks.map((mask) => mask.locations)).toEqual([
        [0, 1],
        [0, 0.5],
      ]);
    });

    it('keeps the top-weighted ramp when no fadeLength is given', () => {
      themeMock.colorScheme = 'light';
      const { container } = render(<ProgressiveBlur layers={2} />);
      // No plateau: each mask is one gradient over the full height.
      for (const mask of gradients(container)) expect(mask.height).toBe('');
    });

    it('drops the dark status-bar scrim when asked to', () => {
      themeMock.colorScheme = 'dark';
      const { container } = render(<ProgressiveBlur fadeLength={24} scrim={false} />);
      expect(hasDarkScrim(container)).toBe(false);
    });

    it.each([
      ['dark', 'rgba(0,0,0,0.3)', 'rgba(0,0,0,0)'],
      ['light', 'rgba(255,255,255,0.3)', 'rgba(255,255,255,0)'],
    ] as const)('washes the blur with the %s scene background, along the same plateau', (scheme, wash, clear) => {
      themeMock.colorScheme = scheme;
      const { container } = render(<ProgressiveBlur layers={1} fadeLength={24} scrim={false} washOpacity={0.3} />);

      const washLayer = gradients(container).find((gradient) => gradient.colors[0] === wash);
      // Fades to a clear version of itself: white to `transparent` goes via grey.
      expect(washLayer?.colors).toEqual([wash, clear]);
      expect(washLayer?.height).toBe('24');
      expect(washLayer?.plateau).toMatchObject({ flex: 1, backgroundColor: wash });
    });

    it('draws no wash by default, and none without a fadeLength', () => {
      themeMock.colorScheme = 'light';
      const plain = render(<ProgressiveBlur layers={1} fadeLength={24} />);
      expect(gradients(plain.container)).toHaveLength(1);
      plain.unmount();

      const ramp = render(<ProgressiveBlur layers={1} washOpacity={0.3} />);
      expect(gradients(ramp.container)).toHaveLength(1);
    });

    // The one caller mounts this on iOS 26 glass only, and paints a band where
    // there is no live blur. So the fallback has no plateau to draw.
    it('keeps the single scene-background fade where there is no live blur', () => {
      surfaceMock.mode = 'solid';
      themeMock.colorScheme = 'light';
      const { container } = render(<ProgressiveBlur fadeLength={24} washOpacity={0.5} scrim={false} />);

      expect(container.querySelector('[data-testid="blur-view"]')).toBeNull();
      const fades = gradients(container);
      expect(fades).toHaveLength(1);
      expect(fades[0].colors).toEqual(['#FFFFFF', '#FFFFFF', 'transparent']);
      expect(fades[0].height).toBe('');
    });
  });
});
