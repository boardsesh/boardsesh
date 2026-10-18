import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from './preference-store';
import {
  DEFAULT_PINNED_CHIPS,
  PINNABLE_CHIP_CATALOG,
  fromStoredPinnedChips,
  normalizePinnedChips,
  toStoredPinnedChips,
  type PinnableChipKind,
} from './pinnable-chips';

// Which quick-filter capsules the user has pinned to a list's capsule row. A
// non-secret UI-layout preference → AsyncStorage via preference-store (NOT
// SecureStore). Device-global, like grade-format-preference: it's a layout
// choice, not per-user sensitive data, so no auth-provider sign-out cleanup is
// needed. Auth-gated capsules just hide at render when signed out; the pin
// persists.
//
// One store per surface, from createPinnedChipsStore: each has its own storage
// key, catalog and defaults, and its own state and listeners, so pinning a
// capsule on one surface never re-renders another surface's row. Reactivity
// mirrors grade-format-preference.ts: a module-level store with
// useSyncExternalStore, so every mounted consumer of ONE store (capsule row,
// sheet pin toggles, token dedup) re-renders live on pin/unpin, sharing ONE load
// + ONE subscription. `snapshot` is rebuilt only in notify() so getSnapshot
// stays referentially stable across renders.

/** What a surface's pin store is built from. */
export type PinnedChipsStoreConfig<K extends string> = {
  /** The preference-store key. Never reuse one: a key holds one surface's saved pins. */
  storageKey: string;
  /** Every pinnable kind, in the fixed order the capsules render in. */
  catalog: readonly K[];
  /** The pins a fresh install starts with; also the fallback for an empty or garbage payload. */
  defaults: readonly K[];
  /**
   * Stored payload → pins in catalog order, without unknown or duplicate kinds.
   * Also runs on every `set`. Override it to migrate retired kinds. Defaults to
   * filtering the catalog by the payload.
   */
  normalize?: (stored: readonly unknown[]) => K[];
  /**
   * Stored payload → pins, on `load` only, for a migration that must not run on
   * a fresh pin change (e.g. adding a newly pinnable kind to lists saved before
   * it existed, which on `set` would re-add a kind the user just unpinned).
   * Return `[]` to fall back to the defaults. Defaults to `normalize`.
   */
  fromStored?: (stored: readonly unknown[]) => K[];
  /** Pins → the payload to persist (e.g. a rollback-safe alias). Defaults to the pins as they are. */
  toStored?: (kinds: readonly K[]) => unknown[];
};

/** What every consumer of a pin store reads. */
export type PinnedChipsState<K extends string> = {
  pinned: readonly K[];
  /** The saved pins have loaded; before that `pinned` is the defaults. */
  loaded: boolean;
  isPinned: (kind: K) => boolean;
  togglePin: (kind: K) => void;
};

export type PinnedChipsStore<K extends string> = {
  storageKey: string;
  /** Live pins for a component; loads the saved set on first mount. */
  usePinnedChips: () => PinnedChipsState<K>;
  load: () => Promise<readonly K[]>;
  set: (kinds: readonly K[]) => Promise<void>;
  toggle: (kind: K) => Promise<void>;
  /** Test-only: reset this store between tests (see grade-format-preference / section-expand-store). */
  resetForTests: () => void;
};

type PinnedChipsSnapshot<K extends string> = { pinned: readonly K[]; loaded: boolean };

function filterByCatalog<K extends string>(catalog: readonly K[]): (stored: readonly unknown[]) => K[] {
  return (stored) => {
    const storedKinds = new Set(stored);
    return catalog.filter((kind) => storedKinds.has(kind));
  };
}

/**
 * Builds an independent, persisted pin store for one capsule row. Call it once
 * per surface at module scope: a new surface adds a catalog, a storage key and a
 * capsule builder, and reads `store.usePinnedChips()`.
 */
export function createPinnedChipsStore<K extends string>(config: PinnedChipsStoreConfig<K>): PinnedChipsStore<K> {
  const { storageKey, defaults } = config;
  const normalize = config.normalize ?? filterByCatalog(config.catalog);
  const fromStored = config.fromStored ?? normalize;
  const toStored = config.toStored ?? ((kinds: readonly K[]): unknown[] => [...kinds]);
  const serverSnapshot: PinnedChipsSnapshot<K> = { pinned: defaults, loaded: false };

  let current: readonly K[] = defaults;
  let hasLoaded = false;
  let snapshot: PinnedChipsSnapshot<K> = { pinned: current, loaded: hasLoaded };
  let loadPromise: Promise<readonly K[]> | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    snapshot = { pinned: current, loaded: hasLoaded };
    for (const listener of listeners) listener();
  }

  async function load(): Promise<readonly K[]> {
    if (hasLoaded) return current;
    const stored = await getPreference<unknown[]>(storageKey);
    // A toggle may have raced in while we awaited storage: honour the user's
    // choice rather than clobbering it with the (now stale) persisted value.
    if (hasLoaded) return current;
    const normalized = Array.isArray(stored) ? fromStored(stored) : defaults;
    // An empty/garbage payload falls back to defaults so the row is never blank.
    current = normalized.length > 0 ? normalized : defaults;
    hasLoaded = true;
    notify();
    return current;
  }

  function ensureLoaded(): Promise<readonly K[]> {
    if (!loadPromise) loadPromise = load();
    return loadPromise;
  }

  async function set(kinds: readonly K[]): Promise<void> {
    current = normalize(kinds);
    hasLoaded = true;
    notify();
    await setPreference(storageKey, toStored(current));
  }

  async function toggle(kind: K): Promise<void> {
    // Wait for the persisted set to load first, so a toggle during the cold-start
    // load window flips the user's SAVED pins, not the transient DEFAULT snapshot.
    // Without this, an early tap would compute DEFAULT±kind and set()'s
    // hasLoaded=true would then make the in-flight load discard the saved set.
    await ensureLoaded();
    const next = current.includes(kind) ? current.filter((pinned) => pinned !== kind) : [...current, kind];
    await set(next);
  }

  function subscribe(onStoreChange: () => void): () => void {
    listeners.add(onStoreChange);
    return () => {
      listeners.delete(onStoreChange);
    };
  }

  const getSnapshot = (): PinnedChipsSnapshot<K> => snapshot;
  const getServerSnapshot = (): PinnedChipsSnapshot<K> => serverSnapshot;
  // Module-level, so its identity never changes between renders.
  const togglePin = (kind: K): void => {
    void toggle(kind);
  };

  function usePinnedChips(): PinnedChipsState<K> {
    const { pinned, loaded } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

    useEffect(() => {
      void ensureLoaded();
    }, []);

    const isPinned = useCallback((kind: K) => pinned.includes(kind), [pinned]);

    return { pinned, loaded, isPinned, togglePin };
  }

  function resetForTests(): void {
    current = defaults;
    hasLoaded = false;
    snapshot = { pinned: current, loaded: hasLoaded };
    loadPromise = null;
    listeners.clear();
  }

  return { storageKey, usePinnedChips, load, set, toggle, resetForTests };
}

// --- The climbs list's pin store --------------------------------------------

export const STORAGE_KEY = 'pinnedFilterChips';

/**
 * The climbs capsule row's pins. Its normalize folds a stored legacy 'shape' pin
 * into Tall + Wide on every load (storage is never rewritten just to migrate),
 * and it persists the rollback-safe form (see toStoredPinnedChips): an older
 * bundle reading this key still finds the Shape chip it knows when Tall + Wide
 * are pinned. Its fromStored also gives a list saved before Recent was pinnable
 * the Recent pin, and keeps Recent off when the saved list carries the
 * unpinned marker (see fromStoredPinnedChips).
 */
export const climbPinnedChipsStore = createPinnedChipsStore<PinnableChipKind>({
  storageKey: STORAGE_KEY,
  catalog: PINNABLE_CHIP_CATALOG,
  defaults: DEFAULT_PINNED_CHIPS,
  normalize: normalizePinnedChips,
  fromStored: fromStoredPinnedChips,
  toStored: toStoredPinnedChips,
});

export const usePinnedChips = climbPinnedChipsStore.usePinnedChips;
export const loadPinnedChips = climbPinnedChipsStore.load;
export const setPinnedChips = climbPinnedChipsStore.set;
export const togglePinnedChip = climbPinnedChipsStore.toggle;

/** Test-only: reset the climbs store between tests (see grade-format-preference / section-expand-store). */
export const resetPinnedChipsStoreForTests = climbPinnedChipsStore.resetForTests;
