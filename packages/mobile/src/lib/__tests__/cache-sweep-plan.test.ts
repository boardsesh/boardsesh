// The cache-deletion rules, tested without a filesystem.
//
// The regression this file exists for: the JS sweeper walks the SAME directory
// the native BoardRenderer modules write into. If it deletes a file the native
// side considers in-flight, the render on the bridge fails with ENOENT and the
// user gets exactly the Sentry storm this issue is also trying to stop. So
// "never touches a foreign file" is asserted on every path, not just eviction.

import { describe, it, expect } from 'vitest';
import {
  classifyOverlayEntry,
  measureOverlayCacheBytes,
  planLruEviction,
  planOverlayCacheClear,
  planStaleArtifactSweep,
  overlayNameMatchesScope,
  cacheKeyForOverlayName,
  MANAGED_TEMP_MIN_AGE_MS,
  OVERLAY_CACHE_TARGET_BYTES,
  type CacheDirEntry,
} from '../cache-sweep-plan';

const NOW = 1_800_000_000_000;

function entry(name: string, sizeBytes: number, ageMs: number | null = 0): CacheDirEntry {
  return { name, sizeBytes, modifiedAtMs: ageMs === null ? null : NOW - ageMs };
}

describe('classifyOverlayEntry', () => {
  it('treats finished overlay PNGs as ours to evict', () => {
    expect(classifyOverlayEntry('v5_f_w400_kilter_1_7_1,20_ab12cd34.png')).toBe('cache-entry');
  });

  it('recognises the Android atomic-write temp by BOTH its prefix and suffix', () => {
    expect(classifyOverlayEntry('.bsov-1234.tmp')).toBe('managed-temp');
    // Prefix without the suffix, and suffix without the prefix, are not ours.
    expect(classifyOverlayEntry('.bsov-1234.png')).toBe('foreign');
    expect(classifyOverlayEntry('scratch.tmp')).toBe('foreign');
  });

  // iOS stages `pngData.write(to:options:.atomic)` as a hidden dot-file in this
  // same directory, and its own pruner skips hidden files. Deleting one is a
  // guaranteed failure for a render already on the bridge.
  it('never claims a hidden file it did not create', () => {
    expect(classifyOverlayEntry('.dat.nosync0f1e.abc')).toBe('foreign');
    expect(classifyOverlayEntry('.DS_Store')).toBe('foreign');
    expect(classifyOverlayEntry('.hidden.png')).toBe('foreign');
  });

  it('leaves anything else alone', () => {
    expect(classifyOverlayEntry('subdirectory')).toBe('foreign');
    expect(classifyOverlayEntry('notes.txt')).toBe('foreign');
  });
});

describe('measureOverlayCacheBytes', () => {
  it('counts only finished PNGs', () => {
    const entries = [entry('a.png', 100), entry('.bsov-1.tmp', 5_000), entry('.DS_Store', 7)];
    expect(measureOverlayCacheBytes(entries)).toBe(100);
  });
});

describe('planLruEviction', () => {
  it('plans nothing while under target', () => {
    const plan = planLruEviction({ entries: [entry('a.png', 10)], targetBytes: 100, nowMs: NOW });
    expect(plan.evictNames).toEqual([]);
    expect(plan.beforeBytes).toBe(10);
    expect(plan.afterBytes).toBe(10);
  });

  it('evicts oldest-modified first and stops as soon as it is under target', () => {
    const plan = planLruEviction({
      entries: [entry('newest.png', 40, 1_000), entry('oldest.png', 40, 90_000), entry('middle.png', 40, 50_000)],
      targetBytes: 80,
      nowMs: NOW,
    });
    expect(plan.evictNames).toEqual(['oldest.png']);
    expect(plan.afterBytes).toBe(80);
  });

  it('evicts an undateable entry first — it is the one we know least about', () => {
    const plan = planLruEviction({
      entries: [entry('dated.png', 40, 90_000), entry('undated.png', 40, null)],
      targetBytes: 40,
      nowMs: NOW,
    });
    expect(plan.evictNames).toEqual(['undated.png']);
  });

  // The whole point of the access clock: mtime says this file is ancient, but a
  // mounted surface read it eight seconds ago and is displaying it right now.
  it('never evicts a protected key, even when it is the oldest', () => {
    const plan = planLruEviction({
      entries: [entry('ancient.png', 60, 900_000), entry('recent.png', 60, 1_000)],
      targetBytes: 60,
      protectedNames: new Set(['ancient']),
      nowMs: NOW,
    });
    expect(plan.evictNames).toEqual(['recent.png']);
  });

  it('never puts a foreign file in an eviction plan', () => {
    const plan = planLruEviction({
      entries: [entry('.dat.nosync0f1e.abc', 10_000, 900_000), entry('a.png', 100, 900_000)],
      targetBytes: 0,
      nowMs: NOW,
    });
    expect(plan.evictNames).toEqual(['a.png']);
    expect(plan.staleTempNames).toEqual([]);
  });

  it('sweeps a managed temp only once it is certainly dead', () => {
    const fresh = planLruEviction({
      entries: [entry('.bsov-1.tmp', 5_000, 1_000)],
      targetBytes: OVERLAY_CACHE_TARGET_BYTES,
      nowMs: NOW,
    });
    expect(fresh.staleTempNames).toEqual([]);

    const orphaned = planLruEviction({
      entries: [entry('.bsov-1.tmp', 5_000, MANAGED_TEMP_MIN_AGE_MS + 1)],
      targetBytes: OVERLAY_CACHE_TARGET_BYTES,
      nowMs: NOW,
    });
    expect(orphaned.staleTempNames).toEqual(['.bsov-1.tmp']);
    // ...and it never counted toward the budget in the first place.
    expect(orphaned.beforeBytes).toBe(0);
  });

  it('evicts a single file bigger than the whole target', () => {
    const plan = planLruEviction({ entries: [entry('huge.png', 500)], targetBytes: 100, nowMs: NOW });
    expect(plan.evictNames).toEqual(['huge.png']);
    expect(plan.afterBytes).toBe(0);
  });
});

describe('planOverlayCacheClear', () => {
  it('clears every finished PNG and every dead temp, and nothing else', () => {
    const plan = planOverlayCacheClear({
      entries: [
        entry('a.png', 100, 10),
        entry('b.png', 200, 10),
        entry('.bsov-old.tmp', 9, MANAGED_TEMP_MIN_AGE_MS + 1),
        entry('.bsov-live.tmp', 9, 10),
        entry('.dat.nosync0f1e.abc', 9, 10),
      ],
      nowMs: NOW,
    });
    expect(plan.deleteNames.sort()).toEqual(['.bsov-old.tmp', 'a.png', 'b.png']);
    expect(plan.freedBytes).toBe(300);
  });
});

describe('planStaleArtifactSweep', () => {
  it('reaps leaked artifacts and leaves recent ones for a retry', () => {
    const plan = planStaleArtifactSweep({
      entries: [entry('kilter-1.db', 271_000_000, 48 * 60 * 60 * 1000), entry('tension-2.db', 40_000_000, 60_000)],
      nowMs: NOW,
      maxAgeMs: 24 * 60 * 60 * 1000,
    });
    expect(plan.deleteNames).toEqual(['kilter-1.db']);
    expect(plan.freedBytes).toBe(271_000_000);
  });

  it('leaves an undateable artifact alone rather than guessing it is dead', () => {
    const plan = planStaleArtifactSweep({
      entries: [entry('kilter-1.db', 271_000_000, null)],
      nowMs: NOW,
      maxAgeMs: 0,
    });
    expect(plan.deleteNames).toEqual([]);
  });
});

describe('overlayNameMatchesScope', () => {
  const name = 'v5_f_w400_kilter_1_7_1,20_ab12cd34.png';

  it('matches the scope that rendered it', () => {
    expect(overlayNameMatchesScope(name, { boardType: 'kilter', layoutId: 1, sizeId: 7 })).toBe(true);
  });

  // The delimiter regression: without the trailing underscore, layout 1 also
  // matches layout 12 and size 7 also matches size 70 — a board removal would
  // silently take a neighbouring board's art with it.
  it('does not match a longer layout or size id that starts with the same digits', () => {
    expect(
      overlayNameMatchesScope('v5_f_w400_kilter_12_7_1,20_ab12cd34.png', {
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 7,
      }),
    ).toBe(false);
    expect(
      overlayNameMatchesScope('v5_f_w400_kilter_1_70_1,20_ab12cd34.png', {
        boardType: 'kilter',
        layoutId: 1,
        sizeId: 7,
      }),
    ).toBe(false);
  });

  it('does not match another board type', () => {
    expect(overlayNameMatchesScope(name, { boardType: 'tension', layoutId: 1, sizeId: 7 })).toBe(false);
  });

  it('never matches a file that is not ours', () => {
    expect(overlayNameMatchesScope('.bsov-kilter_1_7_.tmp', { boardType: 'kilter', layoutId: 1, sizeId: 7 })).toBe(
      false,
    );
  });
});

describe('cacheKeyForOverlayName', () => {
  it('strips the .png so the name maps back onto the in-memory index key', () => {
    expect(cacheKeyForOverlayName('v5_f_w400_kilter_1_7_1,20_ab12cd34.png')).toBe('v5_f_w400_kilter_1_7_1,20_ab12cd34');
  });
});
