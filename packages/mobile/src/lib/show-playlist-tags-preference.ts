import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from './preference-store';

// Whether to show playlist-membership tags on climb list rows. Opt-in: the
// default is OFF, so rows look unchanged until a climber turns it on from
// More → Display. When off, the main climb list also skips the
// per-visible-climb membership fetch entirely.
//
// Structure mirrors `session-recording-preference.ts`: a module-level store read
// via `useSyncExternalStore` with a referentially-stable cached snapshot (rebuilt
// only inside `notify()`), plus a promise-singleton one-time load so any number
// of mounted consumers trigger the AsyncStorage read exactly once.
const STORAGE_KEY = 'showPlaylistTagsOnClimbList';
const DEFAULT_SHOW_PLAYLIST_TAGS = false;

type ShowPlaylistTagsSnapshot = { enabled: boolean; loaded: boolean };

let current = DEFAULT_SHOW_PLAYLIST_TAGS;
let hasLoaded = false;
let snapshot: ShowPlaylistTagsSnapshot = { enabled: current, loaded: hasLoaded };
const listeners = new Set<() => void>();

const SERVER_SNAPSHOT: ShowPlaylistTagsSnapshot = { enabled: DEFAULT_SHOW_PLAYLIST_TAGS, loaded: false };

function notify(): void {
  snapshot = { enabled: current, loaded: hasLoaded };
  for (const listener of listeners) listener();
}

export async function loadShowPlaylistTags(): Promise<boolean> {
  if (hasLoaded) return current;
  const stored = await getPreference<boolean>(STORAGE_KEY);
  // A `setShowPlaylistTagsPreference` may have raced in while we awaited storage;
  // honour the user's choice over the (now stale) persisted value.
  if (hasLoaded) return current;
  // An explicit stored choice (true/false) wins; an absent value falls back to
  // OFF so the tags are opt-in only.
  current = typeof stored === 'boolean' ? stored : DEFAULT_SHOW_PLAYLIST_TAGS;
  hasLoaded = true;
  notify();
  return current;
}

export async function setShowPlaylistTagsPreference(enabled: boolean): Promise<void> {
  current = enabled;
  hasLoaded = true;
  notify();
  await setPreference(STORAGE_KEY, enabled);
}

let loadPromise: Promise<boolean> | null = null;
function ensureShowPlaylistTagsLoaded(): Promise<boolean> {
  if (!loadPromise) {
    loadPromise = loadShowPlaylistTags().catch((error: unknown) => {
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

function getSnapshot(): ShowPlaylistTagsSnapshot {
  return snapshot;
}

function getServerSnapshot(): ShowPlaylistTagsSnapshot {
  return SERVER_SNAPSHOT;
}

export function useShowPlaylistTagsPreference(): {
  enabled: boolean;
  loaded: boolean;
  setEnabled: (enabled: boolean) => void;
} {
  const { enabled, loaded } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    // Swallow read failures here — the load already clears its cached promise so
    // a later mount retries; nothing to do at this call site.
    ensureShowPlaylistTagsLoaded().catch(() => {});
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    void setShowPlaylistTagsPreference(next);
  }, []);

  return { enabled, loaded, setEnabled };
}
