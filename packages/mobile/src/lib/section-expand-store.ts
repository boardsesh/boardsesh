// Persists the expand/collapse state of the climb-card collapsible sections
// (logbook, community, similar climbs) so a section the user opened stays open
// on the next climb and across app restarts. Backed by AsyncStorage via the
// shared preference store; mirrors the singleton/useSyncExternalStore pattern in
// `grade-format-preference.ts` so every mounted section shares one load + one
// subscription.

import { useEffect, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from './preference-store';

// Exported so tests assert against the source of truth rather than duplicating
// the literal (a rename would otherwise leave tests silently checking the wrong
// slot).
export const STORAGE_KEY = 'climbCardSectionExpanded';

type ExpandedMap = Record<string, boolean>;
type ExpandedSnapshot = { map: ExpandedMap; loaded: boolean };

// `current`/`hasLoaded` are the canonical state; `snapshot` is the cached
// compound value every consumer reads via `getSnapshot`. It is rebuilt ONLY in
// `notify()` (only when state actually changes) so `getSnapshot` returns a
// referentially-stable object across renders — required by useSyncExternalStore
// to avoid an infinite render loop.
let current: ExpandedMap = {};
let hasLoaded = false;
let snapshot: ExpandedSnapshot = { map: current, loaded: hasLoaded };
const listeners = new Set<() => void>();

// Stable server snapshot so it never trips the snapshot-changed loop.
const SERVER_SNAPSHOT: ExpandedSnapshot = { map: {}, loaded: false };

function isExpandedMap(value: unknown): value is ExpandedMap {
  if (value == null || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'boolean');
}

function notify(): void {
  snapshot = { map: current, loaded: hasLoaded };
  for (const listener of listeners) listener();
}

export async function loadSectionExpandState(): Promise<ExpandedMap> {
  if (hasLoaded) return current;
  // Guard the read like the write in `setSectionExpanded`: a rejected
  // AsyncStorage.getItem would otherwise leave `loadPromise` permanently
  // rejected with no retry, silently pinning every section to its default.
  const stored = await getPreference<ExpandedMap>(STORAGE_KEY).catch(() => null);
  // A `setSectionExpanded` may have raced in while we awaited storage; honour
  // the user's choice rather than clobbering it with the (now stale) value.
  if (hasLoaded) return current;
  current = isExpandedMap(stored) ? stored : {};
  hasLoaded = true;
  notify();
  return current;
}

// One-time load, memoized as a promise singleton so it fires exactly once no
// matter how many sections mount (or how many times StrictMode re-invokes the
// effect).
let loadPromise: Promise<ExpandedMap> | null = null;
function ensureSectionExpandLoaded(): Promise<ExpandedMap> {
  // Already established by an earlier read or a `setSectionExpanded` — skip the
  // read entirely so the "load once" intent holds even when a write beats the
  // first section's mount.
  if (hasLoaded) return Promise.resolve(current);
  if (!loadPromise) loadPromise = loadSectionExpandState();
  return loadPromise;
}

/** Persist a section's expand state. Best-effort write — a failed persist still
 *  updates the in-memory store so the UI stays responsive this session. */
export function setSectionExpanded(key: string, expanded: boolean): void {
  current = { ...current, [key]: expanded };
  hasLoaded = true;
  notify();
  void setPreference(STORAGE_KEY, current).catch(() => {
    // Storage write failed (full disk, first-install permission race).
    // Persisting a UI preference is best-effort; swallow rather than leak an
    // unhandled rejection.
  });
}

/** Test-only: clear the in-memory singleton so each test starts from a cold
 *  store (mirrors the `resetPinnedChipsStoreForTests` convention). */
export function resetSectionExpandStoreForTests(): void {
  current = {};
  hasLoaded = false;
  snapshot = { map: current, loaded: hasLoaded };
  loadPromise = null;
}

/** Synchronous read of the cached map — `undefined` when this key has no stored
 *  preference yet (or storage hasn't loaded). Lets a section pick its initial
 *  state without a flash when the store is already warm from a prior climb. */
export function getSectionExpandedSync(key: string): boolean | undefined {
  return current[key];
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): ExpandedSnapshot {
  return snapshot;
}

function getServerSnapshot(): ExpandedSnapshot {
  return SERVER_SNAPSHOT;
}

/** Subscribe to a section's persisted expand state. Returns `undefined` for
 *  `expanded` when the key has no stored value (caller should fall back to its
 *  own default). Pass `undefined` as the key to opt out of persistence. */
export function useSectionExpanded(key: string | undefined): { expanded: boolean | undefined; loaded: boolean } {
  const { map, loaded } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Kick the one-time AsyncStorage load from an effect (not render/subscribe).
  useEffect(() => {
    if (key) void ensureSectionExpandLoaded();
  }, [key]);

  return { expanded: key ? map[key] : undefined, loaded };
}
