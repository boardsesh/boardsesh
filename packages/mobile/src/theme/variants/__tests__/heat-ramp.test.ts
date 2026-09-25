// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

// variant-tokens pulls in the theme colour modules, which read
// Platform/PlatformColor at import. Same stub as variant-tokens.test.ts.
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  PlatformColor: (name: string) => name,
}));

import { heatRampByScheme, resolveHeatRamp } from '../variant-tokens';

/** WCAG relative luminance of a `#rrggbb` colour. */
function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('heatRamp', () => {
  it('has five hex stops per scheme', () => {
    for (const scheme of ['light', 'dark'] as const) {
      expect(resolveHeatRamp(scheme)).toHaveLength(5);
      for (const stop of resolveHeatRamp(scheme)) expect(stop).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it('gets strictly brighter toward "many" on the dark field', () => {
    const luminances = heatRampByScheme.dark.map(relativeLuminance);
    for (let index = 1; index < luminances.length; index++) {
      expect(luminances[index]).toBeGreaterThan(luminances[index - 1]);
    }
  });

  it('gets strictly darker toward "many" on the light field', () => {
    const luminances = heatRampByScheme.light.map(relativeLuminance);
    for (let index = 1; index < luminances.length; index++) {
      expect(luminances[index]).toBeLessThan(luminances[index - 1]);
    }
  });

  it('keeps neighbouring stops at least 1.3:1 apart, so each bucket reads on its own', () => {
    for (const ramp of [heatRampByScheme.dark, heatRampByScheme.light]) {
      for (let index = 1; index < ramp.length; index++) {
        expect(contrastRatio(ramp[index], ramp[index - 1])).toBeGreaterThanOrEqual(1.3);
      }
    }
  });
});
