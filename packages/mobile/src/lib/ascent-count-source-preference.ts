import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { DEFAULT_ASCENT_COUNT_SOURCE, isAscentCountSource, type AscentCountSource } from './ascent-count-source';
import { getPreference, setPreference } from './preference-store';

const STORAGE_KEY = 'ascentCountSource';

type AscentCountSourceSnapshot = { source: AscentCountSource; loaded: boolean };

// Module-level store mirroring grade-format-preference: `current`/`hasLoaded`
// are the canonical state; `snapshot` is the cached compound value every
// consumer reads via `getSnapshot`. It is rebuilt ONLY inside `notify()` (i.e.
// only when the state actually changes), so `getSnapshot` returns a
// referentially-stable object across renders — required by `useSyncExternalStore`
// to avoid an infinite render loop. A SINGLE subscription per consumer keeps
// per-row overhead to one listener.
let current: AscentCountSource = DEFAULT_ASCENT_COUNT_SOURCE;
let hasLoaded = false;
let snapshot: AscentCountSourceSnapshot = { source: current, loaded: hasLoaded };
const listeners = new Set<() => void>();

// useSyncExternalStore requires a getServerSnapshot; keep it referentially
// stable too so it never trips the snapshot-changed loop.
const SERVER_SNAPSHOT: AscentCountSourceSnapshot = { source: DEFAULT_ASCENT_COUNT_SOURCE, loaded: false };

function notify(): void {
  // Rebuild the cached snapshot once per actual change, then wake every consumer.
  snapshot = { source: current, loaded: hasLoaded };
  for (const listener of listeners) listener();
}

export async function loadAscentCountSource(): Promise<AscentCountSource> {
  // Already established (a prior load or an explicit set) — don't re-read.
  if (hasLoaded) return current;
  const stored = await getPreference<AscentCountSource>(STORAGE_KEY);
  // A `setAscentCountSourcePreference` may have raced in while we awaited
  // storage; honour the user's choice rather than clobbering it with the (now
  // stale) persisted value.
  if (hasLoaded) return current;
  current = isAscentCountSource(stored) ? stored : DEFAULT_ASCENT_COUNT_SOURCE;
  hasLoaded = true;
  notify();
  return current;
}

export async function setAscentCountSourcePreference(source: AscentCountSource): Promise<void> {
  current = source;
  hasLoaded = true;
  notify();
  await setPreference(STORAGE_KEY, source);
}

// One-time load, memoized as a promise singleton so it fires EXACTLY once no
// matter how many rows mount (or how many times StrictMode re-invokes the
// effect) — the first caller starts it, everyone else awaits the same promise.
let loadPromise: Promise<AscentCountSource> | null = null;
function ensureAscentCountSourceLoaded(): Promise<AscentCountSource> {
  if (!loadPromise) loadPromise = loadAscentCountSource();
  return loadPromise;
}

// Pure subscribe — only registers/unregisters the React-supplied callback. The
// load is triggered from the hook's effect, NOT here (firing async I/O from
// subscribe is a render-phase side effect StrictMode would double-invoke).
function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): AscentCountSourceSnapshot {
  return snapshot;
}

function getServerSnapshot(): AscentCountSourceSnapshot {
  return SERVER_SNAPSHOT;
}

/**
 * The current ascent-count source preference and a setter. Backed by
 * AsyncStorage; loads once across all consumers. Consumers that show counts
 * (list rows, the community headline) read `source` and feed it to
 * `selectSourceCount`.
 */
export function useAscentCountSource(): {
  source: AscentCountSource;
  setSource: (source: AscentCountSource) => void;
  loaded: boolean;
} {
  const { source, loaded } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Kick the one-time AsyncStorage load from an effect (not render/subscribe).
  // The promise singleton makes this idempotent across every mounted row.
  useEffect(() => {
    void ensureAscentCountSourceLoaded();
  }, []);

  const setSource = useCallback((next: AscentCountSource) => {
    void setAscentCountSourcePreference(next);
  }, []);

  return { source, setSource, loaded };
}
