// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import type { ComponentProps, ReactNode } from 'react';

// Capture the props GlassSheetBackground hands to GlassSurface so we can assert
// the sheet material/fallback without exercising GlassSurface's own branching
// (covered by glass-surface.test.tsx).
const glass = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
const theme = vi.hoisted(() => ({
  current: {
    systemColors: { secondaryBackground: '#1C1C1E' },
    // Material variant corners; null on Liquid Glass — both are valid style entries.
    sheet: { corners: { borderTopLeftRadius: 28, borderTopRightRadius: 28 } },
  } as { systemColors: { secondaryBackground: string }; sheet: { corners: unknown } } | null,
}));
const native = vi.hoisted(() => ({
  os: 'ios' as 'ios' | 'android',
  colorScheme: 'light' as 'light' | 'dark',
}));

vi.mock('react-native', () => ({
  Appearance: { getColorScheme: () => native.colorScheme },
  Platform: {
    get OS() {
      return native.os;
    },
  },
  PlatformColor: () => '#F2F2F7',
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({ children, pointerEvents, style }: { children?: ReactNode; pointerEvents?: string; style?: unknown }) =>
    createElement(
      'div',
      {
        'data-pointer-events': pointerEvents,
        style: Array.isArray(style) ? Object.assign({}, ...style.flat().filter(Boolean)) : style,
      },
      children,
    ),
}));

vi.mock('../GlassSurface', () => ({
  GlassSurface: (props: Record<string, unknown>) => {
    glass.props = props;
    return createElement('div', { 'data-testid': 'glass-surface' });
  },
}));

vi.mock('../../providers/theme-provider', () => ({
  useOptionalTheme: () => theme.current,
}));

vi.mock('../../theme/tokens', () => ({
  sheetStyles: { background: { borderTopLeftRadius: 16, borderTopRightRadius: 16 } },
}));

import { GlassSheetBackground } from '../GlassSheetBackground';

// gorhom passes more than style/pointerEvents; the component only reads those.
function renderBackground(props: { style?: unknown; pointerEvents?: string }) {
  return render(createElement(GlassSheetBackground, props as unknown as ComponentProps<typeof GlassSheetBackground>));
}

describe('GlassSheetBackground', () => {
  beforeEach(() => {
    glass.props = null;
    theme.current = {
      systemColors: { secondaryBackground: '#1C1C1E' },
      sheet: { corners: { borderTopLeftRadius: 28, borderTopRightRadius: 28 } },
    };
    native.os = 'ios';
    native.colorScheme = 'light';
  });

  it('renders a regular GlassSurface with the sheet secondary-background fallback', () => {
    const { queryByTestId } = renderBackground({ style: { flex: 1 }, pointerEvents: 'auto' });
    expect(queryByTestId('glass-surface')).not.toBeNull();
    expect(glass.props?.glassEffectStyle).toBe('regular');
    expect(glass.props?.fallbackColor).toBe('#1C1C1E');
    expect(glass.props?.pointerEvents).toBe('auto');
  });

  it("forwards gorhom's positioning style, rounds the top corners, and clips the blur fallback", () => {
    renderBackground({ style: { position: 'absolute' }, pointerEvents: 'none' });
    const styleEntries = glass.props?.style as unknown[];
    const flat = Object.assign({}, ...styleEntries.filter(Boolean)) as Record<string, unknown>;
    expect(flat.position).toBe('absolute'); // gorhom fill passed through
    expect(flat.borderTopLeftRadius).toBe(28); // sheet.corners override wins over sheetStyles' 16
    expect(flat.overflow).toBe('hidden'); // clips the blur-fallback to the rounded corners
  });

  it('falls back to a solid view when gorhom renders it outside the ThemeProvider', () => {
    theme.current = null;
    const { container, queryByTestId } = renderBackground({ style: { position: 'absolute' }, pointerEvents: 'none' });
    const view = container.firstElementChild as HTMLElement | null;
    expect(queryByTestId('glass-surface')).toBeNull();
    expect(glass.props).toBeNull();
    expect(view).not.toBeNull();
    expect(view?.style.backgroundColor).toBe('rgb(242, 242, 247)');
    expect(view?.dataset.pointerEvents).toBe('none');
  });

  it('uses the Android dark fallback when detached without a theme on Android', () => {
    theme.current = null;
    native.os = 'android';
    native.colorScheme = 'dark';
    const { container } = renderBackground({ style: { position: 'absolute' }, pointerEvents: 'none' });
    const view = container.firstElementChild as HTMLElement | null;
    expect(view?.style.backgroundColor).toBe('rgb(24, 18, 37)');
  });
});
