// @vitest-environment jsdom
// The "Graphite" Material theme's contrast and neutrality contract, computed from
// the real exported tokens (no copied numbers): every label, outline and accent
// pairing on every surface step, the nav label over the overlay bar, the ladder's
// order, and chroma 0 on every neutral. The values themselves are documented in
// docs/ai-design-guidelines.md ("Material surfaces: Graphite").
import { describe, expect, it, vi } from 'vitest';

// colors.ts touches Platform/PlatformColor at import; Android skips the iOS branch.
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, PlatformColor: (name: string) => name }));
// react-native-paper imports react-native at load; stub the MD3 base themes.
vi.mock('react-native-paper', () => ({
  MD3LightTheme: { dark: false, colors: { elevation: {} } },
  MD3DarkTheme: { dark: true, colors: { elevation: {} } },
}));

import { blendOpaque } from '@boardsesh/velvet-tokens';
import {
  materialFloatingBarSurface,
  materialSurfaceContainers,
  materialSurfaces,
  materialTonalContainers,
  playDrawerMaterialTint,
  tertiaryFillFallback,
} from '../colors';
import { buildPaperTheme } from '../paper-theme';
import { material } from '../tokens';
import { composeSurfaceColorOverrides, toComposeRgbaHex } from '../expo-ui-modifiers';

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];

const AA_TEXT = 4.5;
const NON_TEXT = 3;

type Rgba = { red: number; green: number; blue: number; alpha: number };

const RGBA_FUNCTION = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;

/** Parse `#RRGGBB` or `rgb[a]()` into channels plus alpha. Throws on anything else. */
function parseColor(color: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const digits = hex[1];
    return {
      red: parseInt(digits.slice(0, 2), 16),
      green: parseInt(digits.slice(2, 4), 16),
      blue: parseInt(digits.slice(4, 6), 16),
      alpha: 1,
    };
  }
  const rgbaFunction = RGBA_FUNCTION.exec(color);
  if (rgbaFunction) {
    const [, red, green, blue, alpha] = rgbaFunction;
    return {
      red: Number(red),
      green: Number(green),
      blue: Number(blue),
      alpha: alpha === undefined ? 1 : Number(alpha),
    };
  }
  throw new Error(`unparseable colour ${color}`);
}

/** Composite `color` (opaque or translucent) over an opaque `ground`; returns opaque channels. */
function compositeOver(color: string, ground: string): Rgba {
  const top = parseColor(color);
  const bottom = parseColor(ground);
  const mix = (topChannel: number, bottomChannel: number) => topChannel * top.alpha + bottomChannel * (1 - top.alpha);
  return {
    red: mix(top.red, bottom.red),
    green: mix(top.green, bottom.green),
    blue: mix(top.blue, bottom.blue),
    alpha: 1,
  };
}

/** WCAG 2.x relative luminance of opaque channels. */
function relativeLuminance({ red, green, blue }: Rgba): number {
  const linear = (channel: number) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

/** WCAG contrast of `foreground` (alpha-composited) on an opaque `ground`. */
function contrast(foreground: string, ground: string): number {
  const groundLuminance = relativeLuminance(parseColor(ground));
  const foregroundLuminance = relativeLuminance(compositeOver(foreground, ground));
  const lighter = Math.max(groundLuminance, foregroundLuminance);
  const darker = Math.min(groundLuminance, foregroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Every surface a Material label can land on: the page, the card, and each container step. */
function allGrounds(scheme: Scheme): Record<string, string> {
  const surfaces = materialSurfaces[scheme];
  const containers = materialSurfaceContainers[scheme];
  return {
    page: surfaces.background,
    card: surfaces.secondaryBackground,
    elevated: surfaces.elevatedSurface,
    lowest: containers.lowest,
    low: containers.low,
    base: containers.base,
    high: containers.high,
    level4: containers.level4,
    highest: containers.highest,
  };
}

/** Where `tertiaryLabel` is allowed (docs: the tertiary-label placement rule). */
function tertiaryGrounds(scheme: Scheme): Record<string, string> {
  const surfaces = materialSurfaces[scheme];
  const containers = materialSurfaceContainers[scheme];
  const shared = {
    page: surfaces.background,
    card: surfaces.secondaryBackground,
    lowest: containers.lowest,
    low: containers.low,
  };
  return scheme === 'dark' ? { ...shared, base: containers.base, high: containers.high } : shared;
}

function expectContrastOnEvery(foreground: string, grounds: Record<string, string>, minimum: number): void {
  for (const [groundName, ground] of Object.entries(grounds)) {
    expect(contrast(foreground, ground), `${foreground} on ${groundName} ${ground}`).toBeGreaterThanOrEqual(minimum);
  }
}

describe.each(SCHEMES)('Graphite Material theme (%s)', (scheme) => {
  const surfaces = materialSurfaces[scheme];
  const containers = materialSurfaceContainers[scheme];
  const m3 = buildPaperTheme(scheme).colors;

  it('keeps label and secondaryLabel at AA on the page, the card and every container step', () => {
    expectContrastOnEvery(surfaces.label, allGrounds(scheme), AA_TEXT);
    expectContrastOnEvery(surfaces.secondaryLabel, allGrounds(scheme), AA_TEXT);
  });

  it('keeps tertiaryLabel at AA everywhere the placement rule allows it', () => {
    expectContrastOnEvery(surfaces.tertiaryLabel, tertiaryGrounds(scheme), AA_TEXT);
  });

  it('keeps the outline at 3:1 on every step', () => {
    expectContrastOnEvery(m3.outline, allGrounds(scheme), NON_TEXT);
  });

  it('keeps the accent and the M3 primary at AA on every step', () => {
    expectContrastOnEvery(surfaces.accent, allGrounds(scheme), AA_TEXT);
    expectContrastOnEvery(m3.primary, allGrounds(scheme), AA_TEXT);
  });

  it('keeps the nav labels at AA on the overlay bar over the worst-case content', () => {
    // Dark bar over a white thumbnail, light bar over a black one.
    const content = scheme === 'dark' ? '#FFFFFF' : '#000000';
    const bar = blendOpaque(m3.surface, content, material.navBar.overlaySurfaceAlpha[scheme]);
    expect(contrast(m3.secondary, bar), `active label on ${bar}`).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(m3.onSurfaceVariant, bar), `inactive label on ${bar}`).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('keeps the active nav label violet: it is the brand primary', () => {
    expect(m3.secondary).toBe(m3.primary);
  });

  it('keeps ink at AA on the opaque tonal containers and on the error fill', () => {
    expect(contrast(m3.onPrimaryContainer, m3.primaryContainer)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(m3.onSecondaryContainer, m3.secondaryContainer)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(m3.onError, m3.error)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(m3.primaryContainer).toBe(materialTonalContainers[scheme].primaryContainer);
    expect(m3.secondaryContainer).toBe(materialTonalContainers[scheme].secondaryContainer);
  });

  it('moves the container ladder one way only: rising in dark, falling in light', () => {
    const ladder = [
      containers.lowest,
      containers.low,
      containers.base,
      containers.high,
      containers.level4,
      containers.highest,
    ];
    const luminances = ladder.map((step) => relativeLuminance(parseColor(step)));
    for (let index = 1; index < luminances.length; index += 1) {
      if (scheme === 'dark') {
        expect(luminances[index], `${ladder[index]} above ${ladder[index - 1]}`).toBeGreaterThan(luminances[index - 1]);
      } else {
        expect(luminances[index], `${ladder[index]} below ${ladder[index - 1]}`).toBeLessThan(luminances[index - 1]);
      }
    }
    // The page sits below the whole dark ladder; in light it sits above it.
    const pageLuminance = relativeLuminance(parseColor(surfaces.background));
    if (scheme === 'dark') expect(pageLuminance).toBeLessThan(luminances[0]);
    else expect(pageLuminance).toBeGreaterThan(luminances[0]);
  });

  it('keeps every Material neutral at chroma 0 (R = G = B)', () => {
    // Every surface role but the accent, which is the one violet the set keeps.
    const neutralSurfaces = Object.entries(surfaces).filter(([role]) => role !== 'accent');
    const neutrals: Record<string, string> = {
      ...Object.fromEntries(neutralSurfaces),
      ...Object.fromEntries(Object.entries(containers).map(([step, color]) => [`containers.${step}`, color])),
      tertiaryFill: tertiaryFillFallback.material[scheme],
      playDrawerTint: playDrawerMaterialTint.material[scheme],
      outline: m3.outline,
      outlineVariant: m3.outlineVariant,
      surfaceVariant: m3.surfaceVariant,
    };
    for (const [role, color] of Object.entries(neutrals)) {
      const { red, green, blue } = parseColor(color);
      expect({ role, green, blue }).toEqual({ role, green: red, blue: red });
    }
  });

  it('ties the Paper elevation levels to the container steps', () => {
    expect(m3.elevation).toEqual({
      level0: 'transparent',
      level1: containers.low,
      level2: containers.base,
      level3: containers.high,
      level4: containers.level4,
      level5: containers.highest,
    });
  });

  it('gives Compose the same surface, container, text and outline colours as the theme', () => {
    const overrides = composeSurfaceColorOverrides(m3, containers, scheme);
    expect(overrides).toEqual({
      background: toComposeRgbaHex(surfaces.background),
      onBackground: toComposeRgbaHex(surfaces.label),
      surface: toComposeRgbaHex(surfaces.secondaryBackground),
      surfaceDim: toComposeRgbaHex(scheme === 'dark' ? surfaces.background : containers.highest),
      surfaceBright: toComposeRgbaHex(scheme === 'dark' ? containers.highest : surfaces.secondaryBackground),
      surfaceContainerLowest: toComposeRgbaHex(containers.lowest),
      surfaceContainerLow: toComposeRgbaHex(scheme === 'dark' ? surfaces.secondaryBackground : containers.low),
      surfaceContainer: toComposeRgbaHex(scheme === 'dark' ? containers.high : containers.base),
      surfaceContainerHigh: toComposeRgbaHex(scheme === 'dark' ? containers.level4 : containers.high),
      surfaceContainerHighest: toComposeRgbaHex(containers.highest),
      surfaceVariant: toComposeRgbaHex(m3.surfaceVariant),
      onSurface: toComposeRgbaHex(surfaces.label),
      onSurfaceVariant: toComposeRgbaHex(surfaces.secondaryLabel),
      outline: toComposeRgbaHex(m3.outline),
      outlineVariant: toComposeRgbaHex(surfaces.separator),
      // The surface itself, so Compose's tonal elevation lays no violet over it.
      surfaceTint: toComposeRgbaHex(surfaces.secondaryBackground),
    });
    // And every role converted, none fell back to the seeded (lilac) palette.
    expect(Object.values(overrides).every((color) => typeof color === 'string')).toBe(true);
    expect(Object.keys(overrides)).toHaveLength(16);
  });

  it('keeps the floating accessory bar readable and lifted off the cards it floats over', () => {
    const bar = materialFloatingBarSurface[scheme];
    expect(contrast(surfaces.label, bar)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(surfaces.secondaryLabel, bar)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(surfaces.accent, bar)).toBeGreaterThanOrEqual(4.5);
    // Dark: lighter than the card and the page, so it never reads as a hole.
    if (scheme === 'dark') {
      expect(relativeLuminance(parseColor(bar))).toBeGreaterThan(
        relativeLuminance(parseColor(surfaces.secondaryBackground)),
      );
      expect(contrast(bar, surfaces.secondaryBackground)).toBeGreaterThanOrEqual(1.2);
    }
  });

  it('floats Compose menus and dialogs on a container that reads against the card', () => {
    const overrides = composeSurfaceColorOverrides(m3, containers, scheme);
    const card = surfaces.secondaryBackground;
    const menu = scheme === 'dark' ? containers.high : containers.base;
    expect(overrides.surfaceContainer).toBe(toComposeRgbaHex(menu));
    // Dark lifts above the card (M3's dark direction); light sinks below white.
    if (scheme === 'dark')
      expect(relativeLuminance(parseColor(menu))).toBeGreaterThan(relativeLuminance(parseColor(card)));
    else expect(relativeLuminance(parseColor(menu))).toBeLessThan(relativeLuminance(parseColor(card)));
  });
});

describe('Liquid Glass keeps its violet values', () => {
  it('splits the tertiary fill and the drawer tint by variant', () => {
    expect(tertiaryFillFallback.liquidGlass).toEqual({
      light: 'rgba(109, 40, 217, 0.06)',
      dark: 'rgba(199, 184, 232, 0.07)',
    });
    expect(playDrawerMaterialTint.liquidGlass.dark).toBe('rgba(15, 11, 22, 0.55)');
    expect(playDrawerMaterialTint.material.dark).toBe('rgba(14, 14, 14, 0.55)');
  });
});
