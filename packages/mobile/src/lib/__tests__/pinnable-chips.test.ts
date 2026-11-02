import { describe, it, expect } from 'vitest';
import {
  PINNABLE_CHIP_CATALOG,
  DEFAULT_PINNED_CHIPS,
  RECENT_UNPINNED_MARKER,
  isValidChipKind,
  fromStoredPinnedChips,
  normalizePinnedChips,
  toStoredPinnedChips,
  chipKindToTokenKeys,
  type PinnableChipKind,
} from '../pinnable-chips';

describe('pinnable-chips catalog', () => {
  it('lists every pinnable control in fixed render order', () => {
    expect([...PINNABLE_CHIP_CATALOG]).toEqual([
      'recent',
      'grade',
      'accuracy',
      'progress',
      'collection',
      'climbType',
      'tall',
      'wide',
      'beta',
      'popularity',
      'rating',
      'sort',
    ]);
  });

  it('defaults to Recent and the Tier-1 chips (reproduces today’s chip row; Tier-2 is opt-in)', () => {
    expect([...DEFAULT_PINNED_CHIPS]).toEqual([
      'recent',
      'grade',
      'progress',
      'collection',
      'tall',
      'wide',
      'popularity',
      'rating',
    ]);
    // Tier-2 controls are in the catalog but not pinned by default.
    for (const optIn of ['accuracy', 'climbType', 'beta', 'sort'] as const) {
      expect(PINNABLE_CHIP_CATALOG).toContain(optIn);
      expect(DEFAULT_PINNED_CHIPS).not.toContain(optIn);
    }
  });

  it('isValidChipKind accepts known kinds and rejects everything else', () => {
    for (const kind of PINNABLE_CHIP_CATALOG) expect(isValidChipKind(kind)).toBe(true);
    expect(isValidChipKind('setters')).toBe(false);
    // The retired Shape menu chip is no longer a kind (its pins migrate instead).
    expect(isValidChipKind('shape')).toBe(false);
    // Neither is the Recent-unpinned marker.
    expect(isValidChipKind(RECENT_UNPINNED_MARKER)).toBe(false);
    expect(isValidChipKind('')).toBe(false);
    expect(isValidChipKind(null)).toBe(false);
    expect(isValidChipKind(42)).toBe(false);
  });
});

describe('normalizePinnedChips', () => {
  it('keeps the saved order: the row draws pins in the order the climber set', () => {
    expect(normalizePinnedChips(['rating', 'grade', 'popularity'])).toEqual(['rating', 'grade', 'popularity']);
    expect(normalizePinnedChips(['sort', 'recent', 'grade'])).toEqual(['sort', 'recent', 'grade']);
  });

  it('drops unknown kinds (incl. the retired "benchmarks") and de-dupes, the first one winning', () => {
    expect(normalizePinnedChips(['grade', 'benchmarks', 'grade', 'wide'])).toEqual(['grade', 'wide']);
    expect(normalizePinnedChips(['wide', 'grade', 'wide'])).toEqual(['wide', 'grade']);
  });

  it('migrates a stored "shape" pin to separate Tall + Wide pins in catalog order', () => {
    expect(normalizePinnedChips(['grade', 'shape', 'rating'])).toEqual(['grade', 'tall', 'wide', 'rating']);
    // The pre-split default set keeps every chip it had.
    expect(normalizePinnedChips(['grade', 'progress', 'collection', 'shape', 'popularity', 'rating'])).toEqual([
      'grade',
      'progress',
      'collection',
      'tall',
      'wide',
      'popularity',
      'rating',
    ]);
    // A "shape" alongside an explicit tall/wide doesn't duplicate them.
    expect(normalizePinnedChips(['tall', 'shape'])).toEqual(['tall', 'wide']);
    // Nor does it move a Tall or Wide the payload names itself.
    expect(normalizePinnedChips(['wide', 'grade', 'tall', 'shape'])).toEqual(['wide', 'grade', 'tall']);
  });

  it('returns an empty array when nothing valid is left', () => {
    expect(normalizePinnedChips(['nope', 123, null])).toEqual([]);
  });
});

describe('fromStoredPinnedChips', () => {
  // What this bundle's DEFAULT_PINNED_CHIPS persisted as before Recent was
  // pinnable: the Tier-1 chips with the 'shape' alias after Wide.
  const savedDefaultsBeforeRecentPin = [
    'grade',
    'progress',
    'collection',
    'tall',
    'wide',
    'shape',
    'popularity',
    'rating',
  ];

  it('gives a list saved before Recent was pinnable the Recent pin first, where it always drew', () => {
    expect(fromStoredPinnedChips(savedDefaultsBeforeRecentPin)).toEqual([...DEFAULT_PINNED_CHIPS]);
    expect(fromStoredPinnedChips(['rating', 'grade'])).toEqual(['recent', 'rating', 'grade']);
    // A customised older list keeps its own pins in its order, plus Recent.
    expect(fromStoredPinnedChips(['sort', 'beta'])).toEqual(['recent', 'sort', 'beta']);
  });

  it('keeps Recent hidden when the list carries the unpinned marker', () => {
    expect(fromStoredPinnedChips(['grade', 'rating', RECENT_UNPINNED_MARKER])).toEqual(['grade', 'rating']);
    // Wherever the marker sits.
    expect(fromStoredPinnedChips([RECENT_UNPINNED_MARKER, 'sort'])).toEqual(['sort']);
  });

  it('keeps a list that already holds Recent as it is', () => {
    expect(fromStoredPinnedChips(['recent', 'grade'])).toEqual(['recent', 'grade']);
    expect(fromStoredPinnedChips(['recent'])).toEqual(['recent']);
  });

  it('returns nothing for an empty or garbage list, so the store falls back to the full defaults', () => {
    // Not Recent alone: that would read the empty list as an older one.
    expect(fromStoredPinnedChips([])).toEqual([]);
    expect(fromStoredPinnedChips(['setters', 42, null])).toEqual([]);
    // A list that held only the marker (every chip unpinned) is empty too.
    expect(fromStoredPinnedChips([RECENT_UNPINNED_MARKER])).toEqual([]);
  });

  it('still migrates a stored "shape" pin alongside the Recent rule', () => {
    expect(fromStoredPinnedChips(['shape'])).toEqual(['recent', 'tall', 'wide']);
    expect(fromStoredPinnedChips(['shape', RECENT_UNPINNED_MARKER])).toEqual(['tall', 'wide']);
  });
});

describe('toStoredPinnedChips', () => {
  it('adds the retired "shape" kind after Wide only when Tall AND Wide are pinned', () => {
    expect(toStoredPinnedChips(['recent', 'grade', 'tall', 'wide', 'rating'])).toEqual([
      'recent',
      'grade',
      'tall',
      'wide',
      'shape',
      'rating',
    ]);
    expect(toStoredPinnedChips(['recent', 'grade', 'tall', 'rating'])).toEqual(['recent', 'grade', 'tall', 'rating']);
    expect(toStoredPinnedChips(['recent', 'wide'])).toEqual(['recent', 'wide']);
  });

  it('ends with the unpinned marker only when Recent is not pinned', () => {
    expect(toStoredPinnedChips(['grade', 'tall', 'wide'])).toEqual(['grade', 'tall', 'wide', 'shape', '!recent']);
    expect(toStoredPinnedChips(['wide'])).toEqual(['wide', '!recent']);
    expect(toStoredPinnedChips([])).toEqual(['!recent']);
    expect(toStoredPinnedChips([...DEFAULT_PINNED_CHIPS])).not.toContain(RECENT_UNPINNED_MARKER);
  });

  it('keeps the climber’s order, with the alias right after Wide', () => {
    expect(toStoredPinnedChips(['sort', 'wide', 'grade', 'tall', 'recent'])).toEqual([
      'sort',
      'wide',
      'shape',
      'grade',
      'tall',
      'recent',
    ]);
  });

  it('loads back to the same set in the same order (the alias folds into Tall + Wide, the marker keeps Recent off)', () => {
    for (const kinds of [
      [...DEFAULT_PINNED_CHIPS],
      DEFAULT_PINNED_CHIPS.filter((kind) => kind !== 'recent'),
      ['recent'],
      ['tall', 'wide'],
      ['grade', 'wide'],
      ['sort'],
      ['sort', 'wide', 'grade', 'tall', 'recent'],
      ['rating', 'tall', 'wide', 'beta'],
      ['wide', 'tall'],
    ] as const) {
      expect(fromStoredPinnedChips(toStoredPinnedChips(kinds))).toEqual([...kinds]);
    }
  });

  it('stays readable by an older bundle, which knows neither Recent nor the marker', () => {
    // A bundle from before Recent was pinnable: its catalog had no 'recent', and its normalize
    // folded 'shape' into Tall + Wide and kept only catalog kinds.
    const olderCatalog = [
      'grade',
      'accuracy',
      'progress',
      'collection',
      'climbType',
      'tall',
      'wide',
      'beta',
      'popularity',
      'rating',
      'sort',
    ];
    const readByOlderBundle = (stored: readonly unknown[]) => {
      const storedKinds = new Set(stored.flatMap((kind) => (kind === 'shape' ? ['tall', 'wide'] : [kind])));
      return olderCatalog.filter((kind) => storedKinds.has(kind));
    };
    expect(readByOlderBundle(toStoredPinnedChips(['grade', 'rating']))).toEqual(['grade', 'rating']);
    // A reordered list reads back in the older catalog's order: every pin, no custom order.
    expect(readByOlderBundle(toStoredPinnedChips(['sort', 'wide', 'recent', 'grade', 'tall']))).toEqual([
      'grade',
      'tall',
      'wide',
      'sort',
    ]);
    expect(readByOlderBundle(toStoredPinnedChips([...DEFAULT_PINNED_CHIPS]))).toEqual([
      'grade',
      'progress',
      'collection',
      'tall',
      'wide',
      'popularity',
      'rating',
    ]);
  });
});

describe('a reordered list in an older bundle', () => {
  // The bundle before custom order (an OTA rollback, a PR preview, the store
  // binary's embedded fallback): it filtered its catalog by the payload, folding
  // 'shape' into Tall + Wide, then gave a list without Recent or its marker Recent.
  const loadInPreviousBundle = (stored: readonly unknown[]): PinnableChipKind[] => {
    const storedKinds = new Set(stored.flatMap((kind) => (kind === 'shape' ? ['tall', 'wide'] : [kind])));
    const pins = PINNABLE_CHIP_CATALOG.filter((kind) => storedKinds.has(kind));
    if (pins.length === 0) return pins;
    const savedBeforeRecentPin = !stored.includes('recent') && !stored.includes(RECENT_UNPINNED_MARKER);
    return savedBeforeRecentPin
      ? PINNABLE_CHIP_CATALOG.filter((kind) => kind === 'recent' || pins.includes(kind))
      : pins;
  };

  it('keeps every pin, in that bundle’s catalog order', () => {
    expect(loadInPreviousBundle(toStoredPinnedChips(['sort', 'wide', 'grade', 'tall']))).toEqual([
      'grade',
      'tall',
      'wide',
      'sort',
    ]);
    expect(loadInPreviousBundle(toStoredPinnedChips(['sort', 'recent', 'beta']))).toEqual(['recent', 'beta', 'sort']);
  });
});

describe('chipKindToTokenKeys', () => {
  it('maps each kind to the filter-token keys it backs', () => {
    const map: Record<PinnableChipKind, readonly string[]> = {
      // Saved searches back no filter token.
      recent: [],
      grade: ['grade'],
      accuracy: ['gradeAccuracy'],
      progress: ['progress'],
      collection: ['benchmark', 'liked'],
      climbType: ['climbType'],
      tall: ['tall'],
      wide: ['wide'],
      beta: ['beta'],
      popularity: ['minAscents'],
      rating: ['minRating'],
      sort: ['sort'],
    };
    for (const kind of PINNABLE_CHIP_CATALOG) {
      expect([...chipKindToTokenKeys(kind)]).toEqual(map[kind]);
    }
  });
});
