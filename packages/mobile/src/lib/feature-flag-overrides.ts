import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getPreference, setPreference, removePreference } from './preference-store';

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

// Whole-object validation: if ANY value is non-boolean the entire persisted bag
// is rejected and load falls back to no overrides. A corrupt write is treated as
// all-or-nothing rather than salvaging the valid keys — simpler and safer than
// partially trusting a malformed blob (the tester can just re-set their flags).
function isOverridesRecord(value: unknown): value is FeatureFlagOverrides {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).every((entry) => typeof entry === 'boolean');
}

export async function loadFeatureFlagOverrides(): Promise<FeatureFlagOverrides> {
  if (hasLoaded) return current;
  const stored = await getPreference<unknown>(STORAGE_KEY);
  // A mutator may have set an override while we awaited storage. Merge rather
  // than replace: the persisted bag is the base, any keys a racing mutator wrote
  // win on top. Replacing here would drop the persisted overrides if a mutator
  // fired during boot (before this read resolved). `current` is EMPTY in the
  // common no-race path, so the merge is just the stored bag.
  const raced = Object.keys(current).length > 0;
  current = { ...(isOverridesRecord(stored) ? stored : EMPTY_OVERRIDES), ...current };
  hasLoaded = true;
  notify();
  // The racing mutator's persist() only wrote its own keys; re-persist the
  // merged bag so the persisted flags it didn't know about survive the next
  // cold boot.
  if (raced) void persist();
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
  // Nothing in memory to clear — return without touching storage. The one-time
  // load (if still pending) settles `loaded` on its own.
  if (Object.keys(current).length === 0) return;
  current = EMPTY_OVERRIDES;
  hasLoaded = true;
  notify();
  // Remove the key rather than writing `{}` — cleaner than leaving an empty bag.
  void removePreference(STORAGE_KEY);
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

// Test-only: reset the module singleton (state + the one-time load promise) so
// each test starts clean. The standalone override test gets this isolation from
// `vi.resetModules()`, but the provider test statically imports
// FeatureFlagsProvider — resetting modules there would bind the provider and
// these mutators to different module instances, so it needs an explicit reset.
export function resetFeatureFlagOverridesForTests(): void {
  // Guard on the test env so the body is dead code in release builds (Metro
  // inlines NODE_ENV, so the reset logic gets stripped from the bundle). Vitest
  // sets NODE_ENV=test, where this runs normally.
  if (process.env.NODE_ENV !== 'test') return;
  current = EMPTY_OVERRIDES;
  hasLoaded = false;
  loadPromise = null;
  notify();
}
