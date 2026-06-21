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

// Minimal RN surface. View renders a <div> exposing its background colour and
// pointerEvents so the solid path and tint overlays are inspectable.
vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return ctrl.os;
    },
  },
  StyleSheet: {
    absoluteFill: { position: 'absolute' },
    create: (styles: unknown) => styles,
  },
  View: ({ children, style, pointerEvents }: { children?: ReactNode; style?: unknown; pointerEvents?: string }) => {
    const flat = Object.assign({}, ...(Array.isArray(style) ? style : [style]).filter(Boolean)) as {
      backgroundColor?: string;
    };
    return createElement('div', { 'data-bg': flat.backgroundColor, 'data-pe': pointerEvents }, children);
  },
}));

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
