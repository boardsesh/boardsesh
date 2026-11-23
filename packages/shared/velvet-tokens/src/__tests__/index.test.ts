import { describe, it, expect } from 'vitest';
import {
  RETIRED_BRAND_COLORS,
  blendOpaque,
  brandColors,
  brandColorsDark,
  currentBrandColor,
  marketingSurfaces,
  materialOutline,
  materialSurfaceContainers,
  materialSurfaces,
  materialTonalContainers,
  withAlpha,
} from '../index';

/** sRGB `#RRGGBB` channels, linearised. */
function linearChannels(hex: string): [number, number, number] {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return [red, green, blue];
}

function contrastRatio(first: string, second: string): number {
  const luminance = (hex: string) => {
    const [red, green, blue] = linearChannels(hex);
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [lighter, darker] = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

/** OKLCH (Björn Ottosson's OKLab, polar), hue in degrees. */
function toOklch(hex: string): { lightness: number; chroma: number; hue: number } {
  const [red, green, blue] = linearChannels(hex);
  const long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  const lightness = 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short;
  const greenRed = 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short;
  const blueYellow = 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short;
  const hue = (Math.atan2(blueYellow, greenRed) * 180) / Math.PI;
  return { lightness, chroma: Math.hypot(greenRed, blueYellow), hue: hue < 0 ? hue + 360 : hue };
}

describe('brand palette anchors', () => {
  it('holds the load-bearing Velvet values per scheme', () => {
    // Foreground vs fill diverge in dark; these are the values the whole web split rests on.
    expect(brandColors.tint).toBe('#5B22F2');
    expect(brandColors.primary).toBe('#5B22F2');
    expect(brandColors.primaryFill).toBe('#5B22F2');
    expect(brandColors.primaryStrong).toBe('#4A16CF');
    expect(brandColors.accent).toBe('#0F9F86');
    expect(brandColors.onPrimary).toBe('#FFFFFF');
    expect(brandColorsDark.tint).toBe('#9784FF');
    expect(brandColorsDark.primary).toBe('#9784FF'); // lifted foreground
    expect(brandColorsDark.primaryFill).toBe('#7855FF'); // dark enough for white text, light enough for a 3:1 edge
    expect(brandColorsDark.primaryStrong).toBe('#A294FF'); // a step lighter, for the wash
  });

  it('keeps tint and fill on one hue, differing only in lightness, with every dark violet on the gamut edge', () => {
    const light = toOklch(brandColors.primaryFill);
    for (const color of [
      brandColors.tint,
      brandColors.primaryStrong,
      brandColorsDark.tint,
      brandColorsDark.primaryFill,
    ]) {
      expect(Math.abs(toOklch(color).hue - light.hue), color).toBeLessThan(7);
    }
    // Dark mode never greys the violet: each dark violet has its blue channel at FF, the
    // sRGB edge for this hue at these lightnesses, so it carries all the chroma it can.
    for (const color of [brandColorsDark.tint, brandColorsDark.primaryFill, brandColorsDark.primaryStrong]) {
      expect(color.slice(5, 7).toUpperCase(), color).toBe('FF');
    }
    // Strong is the same violet one step further from the ground: darker in light, lighter in dark.
    expect(toOklch(brandColors.primaryStrong).lightness).toBeLessThan(toOklch(brandColors.tint).lightness);
    expect(toOklch(brandColorsDark.primaryStrong).lightness).toBeGreaterThan(toOklch(brandColorsDark.tint).lightness);
  });

  it('clears WCAG AA for the tint on its grounds and for white on the fill', () => {
    for (const ground of ['#FFFFFF', '#F2F2F7']) {
      expect(contrastRatio(brandColors.tint, ground), ground).toBeGreaterThanOrEqual(4.5);
    }
    for (const ground of ['#000000', '#1C1C1E', '#2C2C2E']) {
      expect(contrastRatio(brandColorsDark.tint, ground), ground).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(brandColors.onPrimary, brandColors.primaryFill)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(brandColorsDark.onPrimary, brandColorsDark.primaryFill)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps "lit" amber, whatever the spark is, with its own ink at AA in both schemes', () => {
    expect(brandColors.live).toBe('#B45309');
    expect(brandColorsDark.live).toBe('#FBBF24');
    expect(brandColors.live).not.toBe(brandColors.accent);
    expect(brandColorsDark.live).not.toBe(brandColorsDark.accent);
    // The same ink the lit wall button has always drawn: onPrimary in light, onAccent in dark.
    expect(brandColors.onLive).toBe(brandColors.onPrimary);
    expect(brandColorsDark.onLive).toBe(brandColorsDark.onAccent);
    expect(contrastRatio(brandColors.onLive, brandColors.live)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(brandColorsDark.onLive, brandColorsDark.live)).toBeGreaterThanOrEqual(4.5);
  });

  it('gives the dark fill a 3:1 edge on every dark card a filled button sits on', () => {
    // The MiniPlayer's play button on #1A1A1A, iOS cards #1C1C1E and #2C2C2E (WCAG 1.4.11).
    for (const ground of ['#1A1A1A', '#1C1C1E', '#2C2C2E']) {
      expect(contrastRatio(brandColorsDark.primaryFill, ground), ground).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps primaryStrong at 4.5:1 on the 20% fill wash over every sheet', () => {
    for (const ground of ['#FFFFFF', '#F2F2F7']) {
      const wash = blendOpaque(brandColors.primaryFill, ground, 0.2);
      expect(contrastRatio(brandColors.primaryStrong, wash), wash).toBeGreaterThanOrEqual(4.5);
    }
    for (const ground of ['#1C1C1E', '#2C2C2E']) {
      const wash = blendOpaque(brandColorsDark.primaryFill, ground, 0.2);
      expect(contrastRatio(brandColorsDark.primaryStrong, wash), wash).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('pairs the mint spark with the same dark ink in both schemes, at AA on each mint', () => {
    // The spark differs per scheme (#0F9F86 light, #3EE6C1 dark); one dark ink reads on
    // both, so a filled mint chip needs no per-scheme text colour.
    expect(brandColors.accent).toBe('#0F9F86');
    expect(brandColorsDark.accent).toBe('#3EE6C1');
    expect(brandColors.onAccent).toBe('#16111F');
    expect(brandColorsDark.onAccent).toBe(brandColors.onAccent);
    expect(contrastRatio(brandColors.onAccent, brandColors.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(brandColorsDark.onAccent, brandColorsDark.accent)).toBeGreaterThanOrEqual(4.5);
    // Fill or stroke only: the light mint is under 4.5:1 on white, so it never sets text.
    expect(contrastRatio(brandColors.accent, '#FFFFFF')).toBeLessThan(4.5);
    expect(contrastRatio(brandColors.accent, '#FFFFFF')).toBeGreaterThanOrEqual(3);
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

  it('holds the Graphite container ladder the app reads, step for step', () => {
    expect(materialSurfaceContainers).toEqual({
      light: {
        lowest: '#EEEEEE',
        low: '#EAEAEA',
        base: '#E4E4E4',
        high: '#DFDFDF',
        level4: '#DCDCDC',
        highest: '#D9D9D9',
      },
      dark: {
        lowest: '#121212',
        low: '#161616',
        base: '#1A1A1A',
        high: '#262626',
        level4: '#2A2A2A',
        highest: '#2E2E2E',
      },
    });
  });

  it('holds the violet tonal containers and their ink', () => {
    expect(materialTonalContainers).toEqual({
      light: { primaryContainer: '#E1E0FF', secondaryContainer: '#DEDDFC', ink: '#21005D' },
      dark: { primaryContainer: '#483A8E', secondaryContainer: '#34276B', ink: '#E1E0FF' },
    });
  });

  it('holds the M3 outline grey', () => {
    expect(materialOutline).toEqual({ light: '#7A7A7A', dark: '#8A8A8A' });
  });

  it('keeps every container step and the outline a pure grey', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const greys = { ...materialSurfaceContainers[scheme], outline: materialOutline[scheme] };
      for (const [role, color] of Object.entries(greys)) {
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

describe('currentBrandColor', () => {
  it('maps only the swatches the app offered: the old violet and the amber spark', () => {
    expect(Object.keys(RETIRED_BRAND_COLORS).sort()).toEqual(['#6D28D9', '#FF8A3D']);
  });

  it('maps the retired violet swatch to the current fill, in any case', () => {
    expect(currentBrandColor('#6D28D9')).toBe(brandColors.primaryFill);
    expect(currentBrandColor('#6d28d9')).toBe('#5B22F2');
  });

  it('maps the retired amber spark to the current spark', () => {
    expect(currentBrandColor('#FF8A3D')).toBe(brandColors.accent);
    expect(currentBrandColor('#ff8a3d')).toBe('#0F9F86');
  });

  it('leaves any other colour alone: other old brand violets a climber could pick, the current brand', () => {
    for (const color of ['#7C3AED', '#A78BFA', '#5B21B6', '#047857', '#5B22F2', '#0F9F86', '#8B5CF6', 'not-a-colour']) {
      expect(currentBrandColor(color)).toBe(color);
    }
  });

  it('never maps to a colour that is itself retired', () => {
    for (const replacement of Object.values(RETIRED_BRAND_COLORS)) {
      expect(RETIRED_BRAND_COLORS[replacement.toUpperCase()]).toBeUndefined();
    }
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
