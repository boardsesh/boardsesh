// Pure policy: when has the Storage screen genuinely nothing to show?
//
// The interesting case is "no boards, but space still reserved" — removing the last
// board and then failing to compact. Getting this wrong strands the user on an empty
// screen with no way to reclaim the space it exists to reclaim.

import { describe, it, expect } from 'vitest';
import { isStorageScreenEmpty, CACHED_IMAGES_VISIBLE_BYTES, RECLAIMABLE_VISIBLE_BYTES } from '../storage-usage';

describe('isStorageScreenEmpty', () => {
  it('is empty with no boards and nothing reserved', () => {
    expect(isStorageScreenEmpty({ boardCount: 0, reclaimableBytes: 0 })).toBe(true);
  });

  // The regression: the last board is gone but its pages are still on the freelist
  // (the VACUUM failed, or never ran). The screen must stay usable so the compaction
  // can be retried.
  it('is NOT empty when the last board is gone but space is still reserved', () => {
    expect(isStorageScreenEmpty({ boardCount: 0, reclaimableBytes: 26_000_000 })).toBe(false);
  });

  it('is never empty while a board is downloaded', () => {
    expect(isStorageScreenEmpty({ boardCount: 1, reclaimableBytes: 0 })).toBe(false);
  });

  // Issue #3647: hundreds of megabytes of cached board art can accumulate on a
  // device that never downloaded a board. A bare empty state would hide both the
  // number and the only button that clears it.
  it('is NOT empty when nothing is downloaded but the caches are holding real space', () => {
    expect(isStorageScreenEmpty({ boardCount: 0, reclaimableBytes: 0, cachedImageBytes: 180_000_000 })).toBe(false);
  });

  it('ignores a handful of thumbnails the same way it ignores freelist churn', () => {
    expect(
      isStorageScreenEmpty({ boardCount: 0, reclaimableBytes: 0, cachedImageBytes: CACHED_IMAGES_VISIBLE_BYTES - 1 }),
    ).toBe(true);
    expect(
      isStorageScreenEmpty({ boardCount: 0, reclaimableBytes: 0, cachedImageBytes: CACHED_IMAGES_VISIBLE_BYTES }),
    ).toBe(false);
  });

  // SQLite's freelist is basically never empty after ordinary sync churn, so a
  // `> 0` bar would park a Reserved-space row on every device forever.
  it('ignores the handful of freelist pages ordinary churn leaves behind', () => {
    expect(isStorageScreenEmpty({ boardCount: 0, reclaimableBytes: RECLAIMABLE_VISIBLE_BYTES - 1 })).toBe(true);
    expect(isStorageScreenEmpty({ boardCount: 0, reclaimableBytes: RECLAIMABLE_VISIBLE_BYTES })).toBe(false);
  });
});
