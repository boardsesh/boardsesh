import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from './preference-store';

// Local, on-device feature-flag overrides — the highest-precedence layer in the
// FeatureFlagsProvider merge (PostHog < static env < this). A tester flips a
// flag here from the Feature Flags settings screen and the choice sticks across
// restarts, so a gated feature can be exercised without a new build or a PostHog
// rollout change.
//
// Structure mirrors `session-recording-preference.ts`: a module-level store read
// via `useSyncExternalStore` with a referentially-stable cached snapshot
// (rebuilt only inside `notify()` so the provider's `useMemo` doesn't thrash),
// plus a promise-singleton one-time load so any number of mounted consumers
// trigger the AsyncStorage read exactly once. Difference: the value is a
// `Record<string, boolean>` (flag key -> forced value) rather than a single
// boolean. A key being absent means "no override" — fall back to the next layer.
const STORAGE_KEY = 'featureFlagOverrides';

export type FeatureFlagOverrides = Record<string, boolean>;

type OverridesSnapshot = { overrides: FeatureFlagOverrides; loaded: boolean };

const EMPTY_OVERRIDES: FeatureFlagOverrides = {};

let current: FeatureFlagOverrides = EMPTY_OVERRIDES;
let hasLoaded = false;
let snapshot: OverridesSnapshot = { overrides: current, loaded: hasLoaded };
const listeners = new Set<() => void>();

const SERVER_SNAPSHOT: OverridesSnapshot = { overrides: EMPTY_OVERRIDES, loaded: false };

function notify(): void {
  snapshot = { overrides: current, loaded: hasLoaded };
  for (const listener of listeners) listener();
}

function isOverridesRecord(value: unknown): value is FeatureFlagOverrides {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).every((entry) => typeof entry === 'boolean');
}

export async function loadFeatureFlagOverrides(): Promise<FeatureFlagOverrides> {
  if (hasLoaded) return current;
  const stored = await getPreference<unknown>(STORAGE_KEY);
  // A mutator may have raced in while we awaited storage; honour the live state
  // over the (now stale) persisted value.
  if (hasLoaded) return current;
  current = isOverridesRecord(stored) ? stored : EMPTY_OVERRIDES;
  hasLoaded = true;
  notify();
  return current;
}

async function persist(): Promise<void> {
  await setPreference(STORAGE_KEY, current);
}

export function setFeatureFlagOverride(key: string, value: boolean): void {
  current = { ...current, [key]: value };
  hasLoaded = true;
  notify();
  void persist();
}

export function clearFeatureFlagOverride(key: string): void {
  if (!(key in current)) return;
  const next = { ...current };
  delete next[key];
  current = next;
  hasLoaded = true;
  notify();
  void persist();
}

export function clearAllFeatureFlagOverrides(): void {
  if (Object.keys(current).length === 0) {
    // Still mark loaded so a consumer mounted before the first load sees a
    // settled empty state instead of waiting on storage.
    if (hasLoaded) return;
  }
  current = EMPTY_OVERRIDES;
  hasLoaded = true;
  notify();
  void persist();
}

let loadPromise: Promise<FeatureFlagOverrides> | null = null;
function ensureLoaded(): Promise<FeatureFlagOverrides> {
  if (!loadPromise) {
    loadPromise = loadFeatureFlagOverrides().catch((error: unknown) => {
      // A failed read must not leave a rejected promise cached — clear the
      // singleton so the next mount retries instead of staying stuck at the
      // default until the app restarts.
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

function getSnapshot(): OverridesSnapshot {
  return snapshot;
}

function getServerSnapshot(): OverridesSnapshot {
  return SERVER_SNAPSHOT;
}

export function useFeatureFlagOverrides(): {
  overrides: FeatureFlagOverrides;
  loaded: boolean;
  setOverride: (key: string, value: boolean) => void;
  clearOverride: (key: string) => void;
  clearAll: () => void;
} {
  const { overrides, loaded } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    // Swallow read failures here — the load already clears its cached promise so
    // a later mount retries; nothing to do at this call site.
    ensureLoaded().catch(() => {});
  }, []);

  const setOverride = useCallback((key: string, value: boolean) => {
    setFeatureFlagOverride(key, value);
  }, []);
  const clearOverride = useCallback((key: string) => {
    clearFeatureFlagOverride(key);
  }, []);
  const clearAll = useCallback(() => {
    clearAllFeatureFlagOverrides();
  }, []);

  return { overrides, loaded, setOverride, clearOverride, clearAll };
}
