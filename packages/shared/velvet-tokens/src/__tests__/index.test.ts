import { describe, it, expect } from 'vitest';
import { brandColors, brandColorsDark, marketingSurfaces, materialSurfaces, withAlpha, blendOpaque } from '../index';

describe('brand palette anchors', () => {
  it('holds the load-bearing Velvet values per scheme', () => {
    // Foreground vs fill diverge in dark; these are the values the whole web split rests on.
    expect(brandColors.primary).toBe('#6D28D9');
    expect(brandColors.primaryFill).toBe('#6D28D9');
    expect(brandColors.accent).toBe('#FF8A3D');
    expect(brandColors.onPrimary).toBe('#FFFFFF');
    expect(brandColorsDark.primary).toBe('#A78BFA'); // lifted foreground
    expect(brandColorsDark.primaryFill).toBe('#7C3AED'); // fill stays dark for white text
  });

  it('pairs the amber accent with the same dark ink in both schemes', () => {
    // The accent does not change per scheme, so its ink must not either — a filled
    // amber chip is the same colour on a light page and a dark one, and mobile reads
    // `brandColors.onAccent` off whichever set the scheme resolved.
    expect(brandColors.onAccent).toBe('#16111F');
    expect(brandColorsDark.onAccent).toBe(brandColors.onAccent);
    expect(brandColorsDark.accent).toBe(brandColors.accent);
  });

  it('holds the neutral Graphite surface anchors the app reads', () => {
    expect(materialSurfaces.light.background).toBe('#F2F2F2');
    expect(materialSurfaces.dark.background).toBe('#0E0E0E');
    expect(materialSurfaces.dark.secondaryBackground).toBe('#1E1E1E');
    expect(materialSurfaces.light.label).toBe('#1A1A1A');
    expect(materialSurfaces.dark.label).toBe('#EDEDED');
    // The accent is the one violet the surface set keeps.
    expect(materialSurfaces.light.accent).toBe(brandColors.primary);
    expect(materialSurfaces.dark.accent).toBe(brandColorsDark.primary);
  });

  it('keeps every opaque Material surface and label a pure grey', () => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const [role, color] of Object.entries(materialSurfaces[scheme])) {
        if (role === 'accent' || !color.startsWith('#')) continue;
        const red = color.slice(1, 3);
        expect({ role, green: color.slice(3, 5), blue: color.slice(5, 7) }).toEqual({ role, green: red, blue: red });
      }
    }
  });
});

describe('marketingSurfaces', () => {
  it('freezes the violet surfaces the marketing videos were cut against', () => {
    expect(marketingSurfaces.light.background).toBe('#F3EFFA');
    expect(marketingSurfaces.dark.background).toBe('#15101E');
    expect(marketingSurfaces.dark.secondaryBackground).toBe('#221A33');
    expect(marketingSurfaces.light.label).toBe('#16111F');
    expect(marketingSurfaces.dark.label).toBe('#F5F2FB');
    expect(marketingSurfaces.dark.secondaryLabel).toBe('#A9A2B6');
    expect(marketingSurfaces.dark.accent).toBe('#A78BFA');
  });

  it('carries the same roles as the app surfaces, so a render script can swap one for the other', () => {
    expect(Object.keys(marketingSurfaces.light).sort()).toEqual(Object.keys(materialSurfaces.light).sort());
    expect(Object.keys(marketingSurfaces.dark).sort()).toEqual(Object.keys(materialSurfaces.dark).sort());
  });
});

describe('withAlpha', () => {
  it('converts a 6-digit hex to rgba', () => {
    expect(withAlpha('#6D28D9', 0.5)).toBe('rgba(109, 40, 217, 0.5)');
  });

  it('expands a 3-digit hex before converting', () => {
    expect(withAlpha('#abc', 1)).toBe('rgba(170, 187, 204, 1)');
  });

  it('passes non-hex input through unchanged (already rgba / named / PlatformColor)', () => {
    expect(withAlpha('rgba(0, 0, 0, 0.3)', 0.5)).toBe('rgba(0, 0, 0, 0.3)');
    expect(withAlpha('red', 0.5)).toBe('red');
  });
});

describe('blendOpaque', () => {
  it('returns the foreground when fully opaque', () => {
    expect(blendOpaque('#ffffff', '#000000', 1)).toBe('#ffffff');
  });

  it('returns the background when fully transparent', () => {
    expect(blendOpaque('#ffffff', '#000000', 0)).toBe('#000000');
  });

  it('composites to an opaque midpoint', () => {
    expect(blendOpaque('#ffffff', '#000000', 0.5)).toBe('#808080');
  });

  it('passes through when either input is not hex', () => {
    expect(blendOpaque('rgba(0,0,0,0.5)', '#ffffff', 0.5)).toBe('#ffffff');
  });

  it('clamps out-of-range alpha so it never emits an invalid hex', () => {
    expect(blendOpaque('#ffffff', '#000000', 2)).toBe('#ffffff'); // clamps to 1
    expect(blendOpaque('#ffffff', '#000000', -1)).toBe('#000000'); // clamps to 0
  });
});
