import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from './preference-store';

// Persisted lock state for the Tall/Wide board-shape chips. Locking a dimension
// PINS its filter active: the climbs screen re-applies it even after a Reset /
// clear, until the user unlocks it from the chip's long-press menu. A homewall
// climber whose wall is, say, 10x10 can lock "Wide" once and never lose it.
//
// Mirrors feature-flag-overrides.ts: a module-level store read via
// useSyncExternalStore with a referentially-stable cached snapshot (rebuilt only
// in notify()), plus a promise-singleton one-time AsyncStorage load. Internal
// state holds only EXPLICITLY-set keys (`LockOverrides`), so a load that races a
// setter merges the persisted base under the racing key rather than clobbering it
// — a fixed `{tall,wide}` couldn't tell "unset" from "set false" during that race.
//
// `hasReadStorage` tracks "the AsyncStorage read finished", NOT "we have in-memory
// state". Only loadDimensionLocks() sets it; a setter records its override without
// setting it. That split closes a footgun for the public `setDimensionLock` export
// (the hook's useEffect normally reads storage first, but a direct caller need not):
// (1) a setter that runs before the one-time read can't make the read
// short-circuit and silently drop every persisted lock; (2) a setter defers
// persisting until the read has merged the persisted base, so it never overwrites
// storage with a partial in-memory bag.
const STORAGE_KEY = 'dimensionFilterLocks';

export type DimensionKey = 'tall' | 'wide';
export type DimensionLocks = { tall: boolean; wide: boolean };

type LockOverrides = Partial<Record<DimensionKey, boolean>>;

const EMPTY_OVERRIDES: LockOverrides = {};
const EMPTY_LOCKS: DimensionLocks = { tall: false, wide: false };

let current: LockOverrides = EMPTY_OVERRIDES;
let hasReadStorage = false;
let snapshot: DimensionLocks = EMPTY_LOCKS;
const listeners = new Set<() => void>();

function toLocks(overrides: LockOverrides): DimensionLocks {
  return { tall: overrides.tall === true, wide: overrides.wide === true };
}

function notify(): void {
  snapshot = toLocks(current);
  for (const listener of listeners) listener();
}

// Keep only the boolean keys we recognise; anything else is dropped rather than
// trusting a malformed blob.
function readOverrides(value: unknown): LockOverrides {
  if (typeof value !== 'object' || value === null) return EMPTY_OVERRIDES;
  const record = value as Record<string, unknown>;
  const next: LockOverrides = {};
  if (typeof record.tall === 'boolean') next.tall = record.tall;
  if (typeof record.wide === 'boolean') next.wide = record.wide;
  return next;
}

export async function loadDimensionLocks(): Promise<DimensionLocks> {
  if (hasReadStorage) return snapshot;
  const stored = readOverrides(await getPreference<unknown>(STORAGE_KEY));
  // A setter may have written before/during this read. Persisted is the base; any
  // key a pending setter wrote wins on top (`...current` last), so a setter that
  // locked Tall can't drop a persisted Wide.
  const hadPendingWrites = Object.keys(current).length > 0;
  current = { ...stored, ...current };
  hasReadStorage = true;
  notify();
  // Flush the merged bag: a setter that ran before the read deferred its persist
  // to here, so the persisted key it didn't know about survives the next cold boot.
  if (hadPendingWrites) void persist();
  return snapshot;
}

async function persist(): Promise<void> {
  await setPreference(STORAGE_KEY, current);
}

/**
 * Re-pin rule for a locked dimension: pin its filter active only when the chip is
 * visible (the board supports it), the dimension is locked, and the filter isn't
 * already active. Pure so the climbs screen's re-pin effects are unit-testable —
 * the effects call this so the rule lives in exactly one place.
 */
export function shouldPinDimension(chipVisible: boolean, locked: boolean, filterActive: boolean): boolean {
  return chipVisible && locked && !filterActive;
}

/**
 * Re-pin effect for one locked dimension: whenever the lock state, chip
 * visibility, or filter-active state changes, re-apply the filter if
 * shouldPinDimension says so. Extracted from the climbs screen so the re-pin
 * guarantee (a locked filter survives any clear) is testable without rendering
 * the whole screen — `pin` should be a stable `useCallback`.
 */
export function useDimensionRepin(chipVisible: boolean, locked: boolean, filterActive: boolean, pin: () => void): void {
  useEffect(() => {
    if (shouldPinDimension(chipVisible, locked, filterActive)) pin();
  }, [chipVisible, locked, filterActive, pin]);
}

export function setDimensionLock(key: DimensionKey, locked: boolean): void {
  // Record the explicit choice and reflect it immediately. Never short-circuit on
  // the current value: during the pre-read window the snapshot shows the default
  // `false`, so an explicit unlock must still be recorded to win over the
  // about-to-load persisted lock.
  current = { ...current, [key]: locked };
  notify();
  // Persist only once storage has been read — otherwise `current` is a partial bag
  // (just this override) and writing it would clobber other persisted locks. Before
  // the read, kick it off instead: loadDimensionLocks() merges the persisted base
  // under this override and flushes the result (its hadPendingWrites branch).
  if (hasReadStorage) void persist();
  else void ensureLoaded().catch(() => {});
}

let loadPromise: Promise<DimensionLocks> | null = null;
function ensureLoaded(): Promise<DimensionLocks> {
  if (!loadPromise) {
    loadPromise = loadDimensionLocks().catch((error: unknown) => {
      // Don't cache a rejected promise — let the next mount retry.
      loadPromise = null;
      throw error;
    });
  }
  return loadPromise;
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): DimensionLocks {
  return snapshot;
}

function getServerSnapshot(): DimensionLocks {
  return EMPTY_LOCKS;
}

export function useDimensionLocks(): {
  locks: DimensionLocks;
  setLock: (key: DimensionKey, locked: boolean) => void;
} {
  const locks = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    ensureLoaded().catch(() => {});
  }, []);
  const setLock = useCallback((key: DimensionKey, locked: boolean) => setDimensionLock(key, locked), []);
  return { locks, setLock };
}

// Test-only: reset the module singleton (state + the one-time load promise) so
// each test starts clean.
export function resetDimensionLocksForTests(): void {
  if (process.env.NODE_ENV !== 'test') return;
  current = EMPTY_OVERRIDES;
  hasReadStorage = false;
  loadPromise = null;
  snapshot = EMPTY_LOCKS;
  notify();
}
