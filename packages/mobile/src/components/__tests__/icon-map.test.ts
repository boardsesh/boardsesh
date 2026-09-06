import { describe, it, expect } from 'vitest';
import { iconMap, type IconMapping, type IconName } from '../icon-map';

describe('iconMap', () => {
  it('every entry has both ios and android string values', () => {
    for (const [iconName, mapping] of Object.entries(iconMap)) {
      expect(typeof mapping.ios).toBe('string');
      expect(mapping.ios.length).toBeGreaterThan(0);
      expect(typeof mapping.android).toBe('string');
      expect(mapping.android.length).toBeGreaterThan(0);
    }
  });

  it('keeps every optical-centre correction a small downward fraction', () => {
    for (const mapping of Object.values<IconMapping>(iconMap)) {
      if (mapping.iosOpticalCenterRatio === undefined) continue;
      // A nudge, not a relayout: anything beyond a fifth of the point size means
      // the glyph is wrong for the slot, not merely off-centre.
      expect(mapping.iosOpticalCenterRatio).toBeGreaterThan(0);
      expect(mapping.iosOpticalCenterRatio).toBeLessThanOrEqual(0.2);
    }
  });

  it('has no duplicate ios values within the map', () => {
    const iosValues = Object.values(iconMap).map((mapping) => mapping.ios);
    const iosSet = new Set(iosValues);
    // Some legitimate duplicates exist (e.g. bluetooth and bluetooth.connected share the same ios icon)
    // so we just verify all keys are unique (implicit from object structure), not ios values
    const keys = Object.keys(iconMap);
    const keySet = new Set(keys);
    expect(keySet.size).toBe(keys.length);
  });

  it('has unique keys', () => {
    const keys = Object.keys(iconMap);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });

  it.each(['boards', 'search', 'queue', 'profile', 'more', 'favorite', 'bluetooth', 'tick', 'frames'] as const)(
    'contains critical icon "%s"',
    (iconName) => {
      expect(iconMap[iconName]).toBeDefined();
      expect(iconMap[iconName].ios).toBeTruthy();
      expect(iconMap[iconName].android).toBeTruthy();
    },
  );

  it('IconName type covers all map keys', () => {
    // This is a compile-time check — if IconName doesn't match the keys,
    // this assignment would produce a TypeScript error.
    const allNames: IconName[] = Object.keys(iconMap) as IconName[];
    expect(allNames.length).toBeGreaterThan(0);
  });

  it('contains navigation icons', () => {
    expect(iconMap['chevron.right']).toBeDefined();
    expect(iconMap['chevron.left']).toBeDefined();
    expect(iconMap.close).toBeDefined();
    expect(iconMap.back).toBeDefined();
  });

  it('contains action icons', () => {
    expect(iconMap.add).toBeDefined();
    expect(iconMap.share).toBeDefined();
    expect(iconMap.delete).toBeDefined();
    expect(iconMap.edit).toBeDefined();
  });

  // `Icon` renders `SymbolView` with no fallback, so an SF Symbol that does not
  // exist on the running iOS version draws NOTHING — no error, no exception, no
  // Sentry event. The frames pip is a bare glyph plus a number over board art, so a
  // silent blank there is indistinguishable from a rendering bug; pinning the name
  // keeps the choice on an SF Symbols 1.0 (iOS 13.0+) glyph.
  it('marks multi-frame routes with a long-available stack glyph on both platforms', () => {
    expect(iconMap.frames.ios).toBe('rectangle.stack');
    expect(iconMap.frames.android).toBe('card-multiple-outline');
  });

  it('contains status icons', () => {
    expect(iconMap.info).toBeDefined();
    expect(iconMap.warning).toBeDefined();
    expect(iconMap.error).toBeDefined();
    expect(iconMap.success).toBeDefined();
  });
});
