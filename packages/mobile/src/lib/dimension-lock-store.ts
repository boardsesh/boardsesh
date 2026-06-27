import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from './preference-store';

// Persisted lock state for the Tall/Wide board-shape chips. Locking a dimension
// PINS its filter active: the climbs screen re-applies it even after a Reset /
// clear, until the user long-presses the chip to unlock. A homewall climber whose
// wall is, say, 10x10 can lock "Wide" once and never lose it to a filter clear.
//
// Mirrors feature-flag-overrides.ts: a module-level store read via
// useSyncExternalStore with a referentially-stable cached snapshot (rebuilt only
// in notify()), plus a promise-singleton one-time AsyncStorage load.
const STORAGE_KEY = 'dimensionFilterLocks';

export type DimensionKey = 'tall' | 'wide';
export type DimensionLocks = { tall: boolean; wide: boolean };

const EMPTY_LOCKS: DimensionLocks = { tall: false, wide: false };

let current: DimensionLocks = EMPTY_LOCKS;
let hasLoaded = false;
let snapshot: DimensionLocks = current;
const listeners = new Set<() => void>();

function notify(): void {
  snapshot = current;
  for (const listener of listeners) listener();
}

function readLocks(value: unknown): DimensionLocks {
  if (typeof value !== 'object' || value === null) return EMPTY_LOCKS;
  const record = value as Record<string, unknown>;
  return { tall: record.tall === true, wide: record.wide === true };
}

async function load(): Promise<void> {
  if (hasLoaded) return;
  const stored = await getPreference<unknown>(STORAGE_KEY);
  // Don't clobber a lock a mutator set while we awaited storage.
  if (!hasLoaded) {
    current = readLocks(stored);
    hasLoaded = true;
    notify();
  }
}

let loadPromise: Promise<void> | null = null;
function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = load().catch((error: unknown) => {
      loadPromise = null;
      throw error;
    });
  }
  return loadPromise;
}

export function setDimensionLock(key: DimensionKey, locked: boolean): void {
  if (current[key] === locked) return;
  current = { ...current, [key]: locked };
  hasLoaded = true;
  notify();
  void setPreference(STORAGE_KEY, current);
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

// Test-only: reset the module singleton so each test starts clean.
export function resetDimensionLocksForTests(): void {
  if (process.env.NODE_ENV !== 'test') return;
  current = EMPTY_LOCKS;
  hasLoaded = false;
  loadPromise = null;
  notify();
}
