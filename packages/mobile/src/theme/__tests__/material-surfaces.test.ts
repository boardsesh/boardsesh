// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

// colors.ts (and tokens.ts → ios-colors.ts) touch Platform/PlatformColor at
// import; the Android branch skips the iOS PlatformColor path.
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, PlatformColor: (name: string) => name }));

import { materialSurfaceContainers, materialElevationLevels } from '../colors';
import { materialElevationByLevel } from '../tokens';

const SCHEMES = ['light', 'dark'] as const;
const HEX = /^#[0-9a-f]{6}$/;

describe('materialSurfaceContainers', () => {
  it.each(SCHEMES)('resolves five distinct opaque tones (%s)', (scheme) => {
    const ramp = materialSurfaceContainers[scheme];
    const tones = [ramp.lowest, ramp.low, ramp.base, ramp.high, ramp.highest];
    // Every tone is opaque hex (so a surface never shows the screen through it)…
    tones.forEach((tone) => expect(tone).toMatch(HEX));
    // …and all five are DISTINCT — the bug this replaces collapsed light
    // secondaryBackground/tertiaryBackground/elevatedSurface all to #FFFFFF.
    expect(new Set(tones).size).toBe(5);
    // The ramp climbs (more primary tint at each step), so the ends differ.
    expect(ramp.lowest).not.toBe(ramp.highest);
  });
});

describe('materialElevationLevels', () => {
  it.each(SCHEMES)('gives Paper five distinct elevation tones (%s)', (scheme) => {
    const levels = materialElevationLevels(scheme);
    const tones = [levels.level1, levels.level2, levels.level3, levels.level4, levels.level5];
    tones.forEach((tone) => expect(tone).toMatch(HEX));
    expect(new Set(tones).size).toBe(5);
  });
});

describe('materialElevationByLevel', () => {
  it('level 0 is flat (no cast)', () => {
    expect(materialElevationByLevel.level0.shadowOpacity).toBe(0);
    expect(materialElevationByLevel.level0.elevation).toBe(0);
  });

  it('the shadowed levels (sheet L1, dialog/FAB L3) carry a real iOS cast', () => {
    for (const level of ['level1', 'level3'] as const) {
      const cast = materialElevationByLevel[level];
      // iOS renders depth from shadow* props, not `elevation` — so these must be
      // present, or Material-on-iOS would be flat.
      expect(cast.shadowOpacity).toBeGreaterThan(0);
      expect(cast.shadowRadius).toBeGreaterThan(0);
      expect(cast.shadowOffset.height).toBeGreaterThan(0);
    }
  });

  it('Android elevation increases monotonically level0 → level5', () => {
    const elevations = (['level0', 'level1', 'level2', 'level3', 'level4', 'level5'] as const).map(
      (level) => materialElevationByLevel[level].elevation,
    );
    for (let i = 1; i < elevations.length; i++) {
      expect(elevations[i]).toBeGreaterThan(elevations[i - 1]);
    }
  });
});
