// Local, persisted state for "the user tucked away the active-climb accessory
// bar." It holds the queue-item uuid of the climb that was dismissed — NOT a bare
// boolean — so a dismiss attaches to one specific stale climb and stops applying
// the moment a different climb becomes current (its uuid no longer matches).
//
// Crucially this is a UI-only flag: dismissing the bar must NEVER mutate the queue
// (no DELTA_UPDATE_CURRENT_CLIMB / DELTA_REMOVE_QUEUE_ITEM / CLEAR_QUEUE) and never
// release a board hold. The climb stays current and reachable from Record / the
// queue sheet; only the strip is hidden.
//
// Persisted via AsyncStorage (non-secret) so the choice survives a cold start —
// the bar stays tucked away across launches until the user connects to / switches
// boards (see use-accessory-dismiss-resets) or the current climb changes.
//
// Module-store shape mirrors grade-format-preference.ts: `current`/`hasLoaded` are
// canonical; `snapshot` is the referentially-stable compound value consumers read,
// rebuilt ONLY in notify() so useSyncExternalStore never trips its changed-snapshot
// loop. Bump the key suffix if the persisted shape changes.

import { useEffect, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from './preference-store';

const STORAGE_KEY = 'boardsesh_accessory_dismiss_v1';

type DismissSnapshot = { dismissedQueueItemUuid: string | null; loaded: boolean };
type StoredDismiss = { dismissedQueueItemUuid: string | null };

let current: string | null = null;
let hasLoaded = false;
let snapshot: DismissSnapshot = { dismissedQueueItemUuid: current, loaded: hasLoaded };
const listeners = new Set<() => void>();

const SERVER_SNAPSHOT: DismissSnapshot = { dismissedQueueItemUuid: null, loaded: false };

function notify(): void {
  snapshot = { dismissedQueueItemUuid: current, loaded: hasLoaded };
  for (const listener of listeners) listener();
}

export async function loadAccessoryDismiss(): Promise<void> {
  if (hasLoaded) return;
  const stored = await getPreference<StoredDismiss>(STORAGE_KEY);
  // A dismiss/reset may have raced in while we awaited storage — honour it over
  // the (now stale) persisted value.
  if (hasLoaded) return;
  current = stored && typeof stored.dismissedQueueItemUuid === 'string' ? stored.dismissedQueueItemUuid : null;
  hasLoaded = true;
  notify();
}

/** Tuck the bar away for this specific climb (queue-item uuid). */
export function dismissAccessory(queueItemUuid: string): void {
  if (hasLoaded && current === queueItemUuid) return;
  current = queueItemUuid;
  hasLoaded = true;
  notify();
  void setPreference<StoredDismiss>(STORAGE_KEY, { dismissedQueueItemUuid: queueItemUuid });
}

/** Bring the bar back (board connect/switch, ticking the climb, etc.). */
export function resetAccessoryDismiss(): void {
  if (hasLoaded && current === null) return;
  current = null;
  hasLoaded = true;
  notify();
  void setPreference<StoredDismiss>(STORAGE_KEY, { dismissedQueueItemUuid: null });
}

// One-time load, memoized as a promise singleton so it fires exactly once no
// matter how many consumers mount (or how often StrictMode re-invokes effects).
let loadPromise: Promise<void> | null = null;
function ensureLoaded(): Promise<void> {
  if (!loadPromise) loadPromise = loadAccessoryDismiss();
  return loadPromise;
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): DismissSnapshot {
  return snapshot;
}

function getServerSnapshot(): DismissSnapshot {
  return SERVER_SNAPSHOT;
}

export function useDismissedAccessoryUuid(): string | null {
  const { dismissedQueueItemUuid } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // Kick the one-time AsyncStorage hydrate from an effect (not render/subscribe).
  useEffect(() => {
    void ensureLoaded();
  }, []);
  return dismissedQueueItemUuid;
}

// Test-only: reset module state between cases. Not for app use.
export function __resetAccessoryDismissStoreForTests(): void {
  current = null;
  hasLoaded = false;
  snapshot = { dismissedQueueItemUuid: null, loaded: false };
  loadPromise = null;
  listeners.clear();
}
