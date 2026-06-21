// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const ctrl = vi.hoisted(() => ({
  mode: 'material' as 'glass' | 'blur' | 'material' | 'solid',
  variant: 'material' as 'liquidGlass' | 'material',
}));

vi.mock('react-native', () => ({
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('div', { 'data-view': 'true', 'data-style': JSON.stringify(style) }, children),
  StyleSheet: { absoluteFill: {}, create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('../../GlassSurface', () => ({
  GlassSurface: () => createElement('div', { 'data-glass': 'true' }),
}));

vi.mock('../../../hooks/use-effective-surface-mode', () => ({
  useEffectiveSurfaceMode: () => ctrl.mode,
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    variant: ctrl.variant,
    systemColors: {
      elevatedSurface: '#FFFFFF',
      separator: '#CCCCCC',
    },
    m3: { secondaryContainer: '#5A4A90' },
    brandColors: { warning: '#FBBF24' },
    m3SurfaceContainers: { lowest: '#101018', low: '#202028', base: '#2A2138', high: '#33293F', highest: '#3B2F49' },
    materialElevation: {
      level2: { elevation: 2, shadowOpacity: 0.12, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } },
      level3: { elevation: 3, shadowOpacity: 0.14, shadowRadius: 5, shadowOffset: { width: 0, height: 2 } },
    },
  }),
}));

vi.mock('../../../theme/tokens', () => ({
  shadows: { sm: { elevation: 2 } },
}));

vi.mock('../../../theme/colors', () => ({
  withAlpha: (color: string, alpha: number) => `${color}-${alpha}`,
}));

import { AccessoryBarSurface } from '../AccessoryBarSurface';

describe('AccessoryBarSurface', () => {
  beforeEach(() => {
    ctrl.mode = 'material';
    ctrl.variant = 'material';
  });

  it('renders the Material docked treatment as an opaque full-width bar surface', () => {
    const { container } = render(
      <AccessoryBarSurface height={48} treatment="docked">
        child
      </AccessoryBarSurface>,
    );

    const surface = container.querySelector('[data-view]');
    const style = surface?.getAttribute('data-style') ?? '';
    expect(style).toContain('"height":48');
    expect(style).toContain('"borderRadius":0');
    // M3 bottom-bar surface: the surfaceContainer tone (not the old elevatedSurface).
    expect(style).toContain('"backgroundColor":"#2A2138"');
    expect(style).toContain('"borderTopWidth":1');
    expect(style).toContain('"borderTopColor":"#CCCCCC"');
    // The docked bar lifts one elevation step above the tab bar (M3 nav-bar = level 2).
    expect(style).toContain('"elevation":2');
    expect(container.querySelector('[data-glass]')).toBeNull();
  });

  it('keeps Material on the opaque surface path when reduce-transparency resolves mode to solid', () => {
    ctrl.mode = 'solid';
    ctrl.variant = 'material';
    const { container } = render(
      <AccessoryBarSurface height={48} treatment="docked">
        child
      </AccessoryBarSurface>,
    );

    expect(container.querySelector('[data-glass]')).toBeNull();
    expect(container.querySelector('[data-view]')?.getAttribute('data-style')).toContain('"backgroundColor":"#2A2138"');
  });

  it('lights the Material docked bar: opaque base + a violet tint overlay + a higher elevation when connected', () => {
    // "You have control" reads as the active-tab violet tonal + a level-3 cast.
    // The base stays OPAQUE so the list never bleeds through; the violet (a
    // low-alpha role here) is composited as an overlay on top.
    const { container } = render(
      <AccessoryBarSurface height={48} treatment="docked" emphasis="connected">
        child
      </AccessoryBarSurface>,
    );

    const views = Array.from(container.querySelectorAll('[data-view]'));
    const outerStyle = views[0]?.getAttribute('data-style') ?? '';
    // Opaque base (NOT the translucent secondaryContainer) + the level-3 cast.
    expect(outerStyle).toContain('"backgroundColor":"#2A2138"');
    expect(outerStyle).toContain('"elevation":3');
    // A separate violet overlay carries the "active" tone over the opaque base.
    const overlay = views.find((view) =>
      (view.getAttribute('data-style') ?? '').includes('"backgroundColor":"#5A4A90"'),
    );
    expect(overlay).toBeTruthy();
  });
});
