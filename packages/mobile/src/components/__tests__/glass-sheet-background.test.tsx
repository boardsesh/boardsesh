// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import type { ComponentProps } from 'react';

// Capture the props GlassSheetBackground hands to GlassSurface so we can assert
// the sheet material/fallback without exercising GlassSurface's own branching
// (covered by glass-surface.test.tsx).
const glass = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
}));

vi.mock('../GlassSurface', () => ({
  GlassSurface: (props: Record<string, unknown>) => {
    glass.props = props;
    return createElement('div', { 'data-testid': 'glass-surface' });
  },
}));

vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryBackground: '#1C1C1E' },
    // Material variant corners; null on Liquid Glass — both are valid style entries.
    sheet: { corners: { borderTopLeftRadius: 28, borderTopRightRadius: 28 } },
    colorScheme: 'dark',
  }),
}));

vi.mock('../../theme/tokens', () => ({
  sheetStyles: { background: { borderTopLeftRadius: 16, borderTopRightRadius: 16 } },
}));

vi.mock('../../theme/colors', () => ({
  playDrawerMaterialTint: { light: 'rgba(255, 255, 255, 0.6)', dark: 'rgba(15, 11, 22, 0.55)' },
}));

import { GlassSheetBackground } from '../GlassSheetBackground';

// gorhom passes more than style/pointerEvents; the component only reads those.
function renderBackground(props: { style?: unknown; pointerEvents?: string; opaqueMaterial?: boolean }) {
  return render(createElement(GlassSheetBackground, props as unknown as ComponentProps<typeof GlassSheetBackground>));
}

describe('GlassSheetBackground', () => {
  it('renders a regular GlassSurface with the sheet secondary-background fallback', () => {
    const { queryByTestId } = renderBackground({ style: { flex: 1 }, pointerEvents: 'auto' });
    expect(queryByTestId('glass-surface')).not.toBeNull();
    expect(glass.props?.glassEffectStyle).toBe('regular');
    expect(glass.props?.fallbackColor).toBe('#1C1C1E');
    expect(glass.props?.pointerEvents).toBe('auto');
    // M3 modal bottom sheet = surfaceContainerLow (the scrim carries separation).
    expect(glass.props?.role).toBe('low');
  });

  it('leaves the material untinted by default so sibling sheets keep the lighter glass', () => {
    renderBackground({ style: { flex: 1 }, pointerEvents: 'auto' });
    expect(glass.props?.tintColor).toBeUndefined();
  });

  it('tints the material with the scheme-aware play-drawer tint when opaqueMaterial is set', () => {
    renderBackground({ style: { flex: 1 }, pointerEvents: 'auto', opaqueMaterial: true });
    expect(glass.props?.tintColor).toBe('rgba(15, 11, 22, 0.55)'); // dark scheme from the theme mock
  });

  it("forwards gorhom's positioning style, rounds the top corners, and clips the blur fallback", () => {
    renderBackground({ style: { position: 'absolute' }, pointerEvents: 'none' });
    const styleEntries = glass.props?.style as unknown[];
    const flat = Object.assign({}, ...styleEntries.filter(Boolean)) as Record<string, unknown>;
    expect(flat.position).toBe('absolute'); // gorhom fill passed through
    expect(flat.borderTopLeftRadius).toBe(28); // sheet.corners override wins over sheetStyles' 16
    expect(flat.overflow).toBe('hidden'); // clips the blur-fallback to the rounded corners
  });
});
