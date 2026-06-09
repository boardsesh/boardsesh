import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { DEFAULT_GRADE_DISPLAY_FORMAT, type GradeDisplayFormat } from '@boardsesh/play-view';
import { getPreference, setPreference } from './preference-store';

export const GRADE_DISPLAY_FORMATS = ['v-grade', 'font', 'both'] as const satisfies readonly GradeDisplayFormat[];

const STORAGE_KEY = 'gradeDisplayFormat';

type GradeFormatSnapshot = { gradeFormat: GradeDisplayFormat; loaded: boolean };

// Module-level store. `current`/`hasLoaded` are the canonical state; `snapshot`
// is the cached compound value every consumer reads via `getSnapshot`. It is
// rebuilt ONLY inside `notify()` (i.e. only when the state actually changes), so
// `getSnapshot` returns a referentially-stable object across renders — required
// by `useSyncExternalStore` to avoid an infinite render loop. A SINGLE
// subscription per consumer keeps per-row overhead to one listener.
let current: GradeDisplayFormat = DEFAULT_GRADE_DISPLAY_FORMAT;
let hasLoaded = false;
let snapshot: GradeFormatSnapshot = { gradeFormat: current, loaded: hasLoaded };
const listeners = new Set<() => void>();

// useSyncExternalStore requires a getServerSnapshot; keep it referentially
// stable too so it never trips the snapshot-changed loop.
const SERVER_SNAPSHOT: GradeFormatSnapshot = { gradeFormat: DEFAULT_GRADE_DISPLAY_FORMAT, loaded: false };

function isGradeDisplayFormat(value: unknown): value is GradeDisplayFormat {
  return typeof value === 'string' && (GRADE_DISPLAY_FORMATS as readonly string[]).includes(value);
}

function notify(): void {
  // Rebuild the cached snapshot once per actual change, then wake every consumer.
  snapshot = { gradeFormat: current, loaded: hasLoaded };
  for (const listener of listeners) listener();
}

export async function loadGradeDisplayFormat(): Promise<GradeDisplayFormat> {
  // Already established (a prior load or an explicit set) — don't re-read.
  if (hasLoaded) return current;
  const stored = await getPreference<GradeDisplayFormat>(STORAGE_KEY);
  // A `setGradeDisplayFormatPreference` may have raced in while we awaited
  // storage; honour the user's choice rather than clobbering it with the
  // (now stale) persisted value.
  if (hasLoaded) return current;
  current = isGradeDisplayFormat(stored) ? stored : DEFAULT_GRADE_DISPLAY_FORMAT;
  hasLoaded = true;
  notify();
  return current;
}

export async function setGradeDisplayFormatPreference(format: GradeDisplayFormat): Promise<void> {
  current = format;
  hasLoaded = true;
  notify();
  await setPreference(STORAGE_KEY, format);
}

// One-time load, memoized as a promise singleton so it fires EXACTLY once no
// matter how many rows mount (or how many times StrictMode re-invokes the
// effect) — the first caller starts it, everyone else awaits the same promise.
let loadPromise: Promise<GradeDisplayFormat> | null = null;
function ensureGradeFormatLoaded(): Promise<GradeDisplayFormat> {
  if (!loadPromise) loadPromise = loadGradeDisplayFormat();
  return loadPromise;
}

// Pure subscribe — only registers/unregisters the React-supplied callback. The
// load is triggered from the hook's effect, NOT here: `useSyncExternalStore`
// runs `subscribe` during render, and firing async I/O from there is a
// render-phase side effect that StrictMode would double-invoke.
function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): GradeFormatSnapshot {
  return snapshot;
}

function getServerSnapshot(): GradeFormatSnapshot {
  return SERVER_SNAPSHOT;
}

export function useGradeDisplayFormatPreference(): {
  gradeFormat: GradeDisplayFormat;
  loaded: boolean;
  setGradeFormat: (format: GradeDisplayFormat) => void;
} {
  const { gradeFormat, loaded } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Kick the one-time AsyncStorage load from an effect (not render/subscribe).
  // The promise singleton makes this idempotent across every mounted row.
  useEffect(() => {
    void ensureGradeFormatLoaded();
  }, []);

  const setGradeFormat = useCallback((next: GradeDisplayFormat) => {
    void setGradeDisplayFormatPreference(next);
  }, []);

  return { gradeFormat, loaded, setGradeFormat };
}
