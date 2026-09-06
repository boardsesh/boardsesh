import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from './preference-store';
import type { ClimbListDensity } from '../components/climb-list-thumbnail-metrics';

// How much of a climb the climbs list packs into a row — compact / default / rich.
// A user setting (More → Climb list) that defaults to `default`, which is today's
// row byte-for-byte: a climber who never opens the setting sees no change at all.
//
// The store is TRI-STATE — `choice` is `undefined` until the climber makes an
// explicit choice, at which point their value wins over the default; so a choice
// made in an earlier session always survives a change to `DEFAULT_DENSITY`.
//
// Structure mirrors `climb-quick-actions-button-preference.ts`: a module-level
// store read via `useSyncExternalStore` with a referentially-stable cached
// snapshot (rebuilt only inside `notify()`), plus a promise-singleton one-time
// load so any number of mounted consumers trigger the AsyncStorage read once.
const STORAGE_KEY = 'climbListDensity';

// Default when the climber hasn't chosen — today's row, unchanged.
const DEFAULT_DENSITY: ClimbListDensity = 'default';

const DENSITIES: readonly ClimbListDensity[] = ['compact', 'default', 'rich'];

/** Storage is untyped JSON, so a stale/corrupt value must not become a density. */
function isClimbListDensity(value: unknown): value is ClimbListDensity {
  return typeof value === 'string' && (DENSITIES as readonly string[]).includes(value);
}

type ChoiceSnapshot = { choice: ClimbListDensity | undefined; loaded: boolean };

let current: ClimbListDensity | undefined;
let hasLoaded = false;
let snapshot: ChoiceSnapshot = { choice: current, loaded: hasLoaded };
const listeners = new Set<() => void>();

const SERVER_SNAPSHOT: ChoiceSnapshot = { choice: undefined, loaded: false };

function notify(): void {
  snapshot = { choice: current, loaded: hasLoaded };
  for (const listener of listeners) listener();
}

export async function loadClimbListDensityChoice(): Promise<ClimbListDensity | undefined> {
  if (hasLoaded) return current;
  const stored = await getPreference<unknown>(STORAGE_KEY);
  // A `setClimbListDensityPreference` may have raced in while we awaited storage;
  // honour the user's choice over the (now stale) persisted value.
  if (hasLoaded) return current;
  // An explicit stored tier wins; anything else stays `undefined` so the hook
  // falls back to the default.
  current = isClimbListDensity(stored) ? stored : undefined;
  hasLoaded = true;
  notify();
  return current;
}

export async function setClimbListDensityPreference(density: ClimbListDensity): Promise<void> {
  current = density;
  hasLoaded = true;
  notify();
  await setPreference(STORAGE_KEY, density);
}

let loadPromise: Promise<ClimbListDensity | undefined> | null = null;
function ensureLoaded(): Promise<ClimbListDensity | undefined> {
  if (!loadPromise) {
    loadPromise = loadClimbListDensityChoice().catch((error: unknown) => {
      // A failed read must not leave a rejected promise cached — clear the
      // singleton so the next mount retries instead of staying stuck until the
      // app restarts.
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

function getSnapshot(): ChoiceSnapshot {
  return snapshot;
}

function getServerSnapshot(): ChoiceSnapshot {
  return SERVER_SNAPSHOT;
}

/**
 * The effective climbs-list density: the climber's explicit choice if they've made
 * one, otherwise `default`. Backs both the climbs list and the More → Climb list
 * segmented control.
 *
 * `density` is a PRIMITIVE on purpose — consumers subscribe to the value itself and
 * drop it straight into a `renderItem` dependency array, never into a context object.
 */
export function useClimbListDensity(): {
  density: ClimbListDensity;
  loaded: boolean;
  setDensity: (density: ClimbListDensity) => void;
} {
  const { choice, loaded } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    // Swallow read failures here — the load already clears its cached promise so a
    // later mount retries; nothing to do at this call site.
    ensureLoaded().catch(() => {});
  }, []);

  const setDensity = useCallback((next: ClimbListDensity) => {
    void setClimbListDensityPreference(next);
  }, []);

  return { density: choice ?? DEFAULT_DENSITY, loaded, setDensity };
}
