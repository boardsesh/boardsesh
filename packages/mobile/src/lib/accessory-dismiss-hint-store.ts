// "Has the one-time dismiss coachmark been seen?" — a single persisted boolean,
// shown once while the bar is in the dismissible (no climbing-signal) state to
// teach that the strip can be tucked away. Same module-store pattern as
// grade-format-preference.ts; persisted via AsyncStorage (non-secret).

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from './preference-store';

const STORAGE_KEY = 'boardsesh_accessory_dismiss_hint_seen_v1';

type HintSnapshot = { seen: boolean; loaded: boolean };

let seen = false;
let hasLoaded = false;
let snapshot: HintSnapshot = { seen, loaded: hasLoaded };
const listeners = new Set<() => void>();

const SERVER_SNAPSHOT: HintSnapshot = { seen: false, loaded: false };

function notify(): void {
  snapshot = { seen, loaded: hasLoaded };
  for (const listener of listeners) listener();
}

async function load(): Promise<void> {
  if (hasLoaded) return;
  const stored = await getPreference<boolean>(STORAGE_KEY);
  if (hasLoaded) return;
  seen = stored === true;
  hasLoaded = true;
  notify();
}

export function markAccessoryDismissHintSeen(): void {
  if (hasLoaded && seen) return;
  seen = true;
  hasLoaded = true;
  notify();
  void setPreference<boolean>(STORAGE_KEY, true);
}

let loadPromise: Promise<void> | null = null;
function ensureLoaded(): Promise<void> {
  if (!loadPromise) loadPromise = load();
  return loadPromise;
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): HintSnapshot {
  return snapshot;
}

function getServerSnapshot(): HintSnapshot {
  return SERVER_SNAPSHOT;
}

export function useAccessoryDismissHintSeen(): { seen: boolean; loaded: boolean; markSeen: () => void } {
  const { seen: seenValue, loaded } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    void ensureLoaded();
  }, []);
  const markSeen = useCallback(() => {
    markAccessoryDismissHintSeen();
  }, []);
  return { seen: seenValue, loaded, markSeen };
}
