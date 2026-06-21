// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';

const ctrl = vi.hoisted(() => ({
  os: 'ios' as 'ios' | 'android',
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  systemColors: { background: '#F3EFFA', label: '#16111F' },
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return ctrl.os;
    },
  },
  PlatformColor: (name: string) => name,
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ variant: ctrl.variant, systemColors: ctrl.systemColors }),
}));

// `glassStackScreenOptions` reads `Platform.OS` at MODULE LOAD, so re-import the
// hook per case (after setting `ctrl.os`) to exercise the iOS vs Android branch —
// a single pinned `Platform.OS` would hide the Android path entirely.
async function readOptions(): Promise<Record<string, unknown>> {
  vi.resetModules();
  const { useStackScreenOptions } = await import('../use-stack-screen-options');
  function Probe() {
    return createElement('div', { 'data-opts': JSON.stringify(useStackScreenOptions()) });
  }
  const { container } = render(createElement(Probe));
  return JSON.parse(container.querySelector('div')?.getAttribute('data-opts') ?? '{}');
}

describe('useStackScreenOptions', () => {
  beforeEach(() => {
    ctrl.os = 'ios';
    ctrl.variant = 'liquidGlass';
  });

  it('Liquid Glass on iOS → transparent blur header over transparent content', async () => {
    const opts = await readOptions();
    expect(opts.headerTransparent).toBe(true);
    expect(opts.headerBlurEffect).toBe('systemMaterial');
    expect(opts.headerBackButtonDisplayMode).toBe('minimal');
    // The blur header floats over TRANSPARENT content — if this regresses (e.g.
    // glassStackScreenOptions stops supplying it), content renders opaque under the
    // blur on iOS. The screens dropped their own `contentStyle` to rely on this.
    expect(opts.contentStyle).toEqual({ backgroundColor: 'transparent' });
    expect(opts.headerStyle).toBeUndefined();
  });

  it('Liquid Glass on Android → opaque (solid) header, not a transparent blur', async () => {
    ctrl.os = 'android';
    const opts = await readOptions();
    // Edge-to-edge Android draws a transparent header under the status bar, so
    // glassStackScreenOptions keeps it solid here. Covers the non-iOS branch the
    // module-load `Platform.OS` read would otherwise hide.
    expect(opts.headerTransparent).toBe(false);
  });

  it('Material → opaque M3 app bar (solid surface, onSurface tint, no blur)', async () => {
    ctrl.variant = 'material';
    const opts = await readOptions();
    expect(opts.headerTransparent).toBe(false);
    expect(opts.headerStyle).toEqual({ backgroundColor: '#F3EFFA' }); // systemColors.background
    expect(opts.headerTintColor).toBe('#16111F'); // systemColors.label
    expect(opts.headerTitleAlign).toBe('left');
    expect(opts.headerShadowVisible).toBe(false);
    // The iOS blur is a Liquid-Glass-only affordance — never on the Material header.
    expect(opts.headerBlurEffect).toBeUndefined();
  });

  it('Material on Android → still the opaque M3 app bar (variant wins over platform)', async () => {
    ctrl.os = 'android';
    ctrl.variant = 'material';
    const opts = await readOptions();
    expect(opts.headerTransparent).toBe(false);
    expect(opts.headerStyle).toEqual({ backgroundColor: '#F3EFFA' });
  });
});
