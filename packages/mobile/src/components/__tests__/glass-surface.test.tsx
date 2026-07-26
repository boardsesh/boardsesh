// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Controls the rendering branch under test.
const ctrl = vi.hoisted(() => ({
  os: 'ios' as string,
  glass: true,
  glassApi: true,
  rt: false,
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
}));

// Minimal RN surface. View renders a <div> exposing its background colour, its
// clip and its elevation so the solid path, the tint overlays and the hoisted
// clip wrapper are all inspectable.
vi.mock('react-native', async () => {
  // Dynamic import: Vitest hoists this factory above the file's imports.
  const { flattenStyle } = await import('../../../test/flatten-style');
  return {
    Platform: {
      get OS() {
        return ctrl.os;
      },
    },
    StyleSheet: {
      absoluteFill: { position: 'absolute' },
      create: (styles: unknown) => styles,
      flatten: flattenStyle,
    },
    View: ({ children, style, pointerEvents }: { children?: ReactNode; style?: unknown; pointerEvents?: string }) => {
      const flat = flattenStyle(style);
      return createElement(
        'div',
        {
          'data-bg': flat.backgroundColor,
          'data-pe': pointerEvents,
          'data-overflow': flat.overflow,
          'data-elevation': flat.elevation,
        },
        children,
      );
    },
  };
});

vi.mock('@react-native-community/blur', () => ({
  BlurView: () => createElement('div', { 'data-testid': 'blur-view' }),
}));

vi.mock('expo-glass-effect', () => ({
  GlassView: ({ tintColor, children }: { tintColor?: string; children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'glass-view', 'data-tint': tintColor }, children),
  isLiquidGlassAvailable: () => ctrl.glass,
  isGlassEffectAPIAvailable: () => ctrl.glassApi,
}));

vi.mock('../../hooks/use-reduce-transparency', () => ({
  useReduceTransparency: () => ctrl.rt,
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryBackground: '#1C1C1E', elevatedSurface: '#2C2C2E' },
    colorScheme: 'dark',
    variant: ctrl.variant,
    m3SurfaceContainers: { lowest: '#101018', low: '#202028', base: '#303038', high: '#404048', highest: '#505058' },
    materialElevation: {
      level0: { elevation: 0 },
      level1: { elevation: 1, shadowOpacity: 0.1 },
      level2: { elevation: 2 },
      level3: { elevation: 3, shadowOpacity: 0.14 },
      level4: { elevation: 4 },
      level5: { elevation: 5 },
    },
  }),
}));

vi.mock('../../theme/ios-colors', () => ({
  iosDarkColors: { secondaryBackground: '#1C1C1E' },
  iosLightColors: { secondaryBackground: '#F2F2F7' },
}));

// Real tokens.ts pulls in PlatformColor via ios-colors; the material branch only
// needs shadows.sm, so stub it.
vi.mock('../../theme/tokens', () => ({ shadows: { sm: {} } }));

import { GlassSurface } from '../GlassSurface';

beforeEach(() => {
  ctrl.os = 'ios';
  ctrl.glass = true;
  ctrl.glassApi = true;
  ctrl.rt = false;
  ctrl.variant = 'liquidGlass';
});

describe('GlassSurface fallback hierarchy', () => {
  it('renders real Liquid Glass on iOS 26+', () => {
    const { queryByTestId } = render(<GlassSurface />);
    expect(queryByTestId('glass-view')).not.toBeNull();
    expect(queryByTestId('blur-view')).toBeNull();
  });

  it('falls back to BlurView on iOS < 26 (Liquid Glass unavailable)', () => {
    ctrl.glass = false;
    const { queryByTestId } = render(<GlassSurface />);
    expect(queryByTestId('blur-view')).not.toBeNull();
    expect(queryByTestId('glass-view')).toBeNull();
  });

  it('falls back to BlurView when the glass-effect API check fails', () => {
    ctrl.glassApi = false;
    const { queryByTestId } = render(<GlassSurface />);
    expect(queryByTestId('blur-view')).not.toBeNull();
    expect(queryByTestId('glass-view')).toBeNull();
  });

  it('renders a solid themed surface on Android (no glass, no blur)', () => {
    ctrl.os = 'android';
    const { queryByTestId, container } = render(<GlassSurface />);
    expect(queryByTestId('glass-view')).toBeNull();
    expect(queryByTestId('blur-view')).toBeNull();
    expect(container.querySelector('[data-bg="#1C1C1E"]')).not.toBeNull();
  });

  it('Reduce Transparency takes priority over Liquid Glass — solid surface', () => {
    ctrl.rt = true; // even though iOS 26 + glass are available
    const { queryByTestId } = render(<GlassSurface />);
    expect(queryByTestId('glass-view')).toBeNull();
    expect(queryByTestId('blur-view')).toBeNull();
  });

  it('renders an opaque Material surface on the Material variant — even on iOS 26 hardware', () => {
    ctrl.variant = 'material'; // glass is available, but the user chose Material
    const { queryByTestId, container } = render(<GlassSurface />);
    expect(queryByTestId('glass-view')).toBeNull();
    expect(queryByTestId('blur-view')).toBeNull();
    expect(container.querySelector('[data-bg="#1C1C1E"]')).not.toBeNull();
  });

  it('composites a translucent fallbackColor over an opaque base (no see-through) on Material', () => {
    // The climbs search bar passes the faint `fill` token as its fallback; it
    // must not punch a hole through the surface on the no-glass paths.
    ctrl.variant = 'material';
    const { container } = render(<GlassSurface fallbackColor="rgba(1, 2, 3, 0.1)" />);
    // Opaque secondary-background base is present...
    expect(container.querySelector('[data-bg="#1C1C1E"]')).not.toBeNull();
    // ...with the translucent fill layered on top as a tint.
    expect(container.querySelector('[data-bg="rgba(1, 2, 3, 0.1)"]')).not.toBeNull();
  });

  it('composites a translucent fallbackColor over an opaque base on the solid path too', () => {
    ctrl.rt = true; // solid path
    const { container } = render(<GlassSurface fallbackColor="rgba(1, 2, 3, 0.1)" />);
    expect(container.querySelector('[data-bg="#1C1C1E"]')).not.toBeNull();
    expect(container.querySelector('[data-bg="rgba(1, 2, 3, 0.1)"]')).not.toBeNull();
  });

  it('Reduce Transparency still wins over the Material variant — solid surface', () => {
    ctrl.variant = 'material';
    ctrl.rt = true;
    const { queryByTestId } = render(<GlassSurface />);
    expect(queryByTestId('glass-view')).toBeNull();
    expect(queryByTestId('blur-view')).toBeNull();
  });

  it('applies tintColor as an overlay on the BlurView path', () => {
    ctrl.glass = false;
    const { container } = render(<GlassSurface tintColor="rgba(1, 2, 3, 0.2)" />);
    expect(container.querySelector('[data-bg="rgba(1, 2, 3, 0.2)"]')).not.toBeNull();
  });

  it('passes tintColor to GlassView (no overlay) on the glass path', () => {
    const { queryByTestId, container } = render(<GlassSurface tintColor="rgba(1, 2, 3, 0.2)" />);
    expect(queryByTestId('glass-view')?.getAttribute('data-tint')).toBe('rgba(1, 2, 3, 0.2)');
    expect(container.querySelector('[data-bg="rgba(1, 2, 3, 0.2)"]')).toBeNull();
  });
});

describe('GlassSurface Material surface-container role', () => {
  it('paints the role tone (not the legacy base) on the Material branch', () => {
    ctrl.variant = 'material';
    const { container } = render(<GlassSurface role="low" />);
    // The `low` container tone is the surface...
    expect(container.querySelector('[data-bg="#202028"]')).not.toBeNull();
    // ...and the legacy opaque secondary-background base is no longer used.
    expect(container.querySelector('[data-bg="#1C1C1E"]')).toBeNull();
  });

  it('lets the role tone win over an opaque fallbackColor (no cover-up)', () => {
    // A role IS the surface; an opaque fallback would hide it, so it must be
    // skipped (unlike the no-role case, where the fallback composites over base).
    ctrl.variant = 'material';
    const { container } = render(<GlassSurface role="base" fallbackColor="#FFFFFF" />);
    expect(container.querySelector('[data-bg="#303038"]')).not.toBeNull();
    expect(container.querySelector('[data-bg="#FFFFFF"]')).toBeNull();
  });
});

// Android draws the elevation cast from the elevated view's own outline, so a
// consumer `overflow: 'hidden'` on that view clips the shadow away entirely
// (#3058). GlassSurface hoists the clip onto an inner wrapper instead.
describe('GlassSurface Material elevation cast vs. a consumer clip', () => {
  beforeEach(() => {
    ctrl.variant = 'material';
  });

  it('keeps the cast off the clipped view: elevated outer is unclipped, children get a clipping wrapper', () => {
    const { container } = render(
      <GlassSurface role="high" level="level3" borderRadius={16} style={{ borderRadius: 16, overflow: 'hidden' }}>
        <div data-testid="card-content" />
      </GlassSurface>,
    );

    // The view carrying the cast must not clip.
    const elevated = container.querySelector('[data-elevation="3"]');
    expect(elevated).not.toBeNull();
    expect(elevated?.getAttribute('data-overflow')).toBe('visible');

    // ...and the clip lives on a descendant that still wraps the children.
    const clip = container.querySelector('[data-overflow="hidden"]');
    expect(clip).not.toBeNull();
    expect(elevated?.contains(clip as Node)).toBe(true);
    expect(clip?.querySelector('[data-testid="card-content"]')).not.toBeNull();
  });

  it("hoists overflow: 'scroll' too — it clips the cast on Android just like 'hidden'", () => {
    const { container } = render(
      <GlassSurface role="high" level="level3" borderRadius={16} style={{ borderRadius: 16, overflow: 'scroll' }}>
        <div data-testid="card-content" />
      </GlassSurface>,
    );
    const elevated = container.querySelector('[data-elevation="3"]');
    expect(elevated?.getAttribute('data-overflow')).toBe('visible');
    expect(container.querySelector('[data-overflow="hidden"] [data-testid="card-content"]')).not.toBeNull();
  });

  it('adds no wrapper when the consumer does not ask for a clip', () => {
    const { container } = render(
      <GlassSurface role="high" level="level3" borderRadius={16} style={{ borderRadius: 16 }}>
        <div data-testid="card-content" />
      </GlassSurface>,
    );
    expect(container.querySelector('[data-overflow="hidden"]')).toBeNull();
    // Children stay direct descendants of the elevated view — no layout shift for
    // the consumers that never clipped.
    const elevated = container.querySelector('[data-elevation="3"]');
    expect(elevated?.firstElementChild?.getAttribute('data-testid')).toBe('card-content');
  });
});
