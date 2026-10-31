import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { getPreference, setPreference } from '../preference-store';

// The "On the wall" strip the climber closed. The strip follows the selected
// board, not a Bluetooth link, and the server keeps a wall's last lit climb
// until its lighter reports a disconnect — an app that dies never does, so a
// climb lit yesterday can sit on the strip indefinitely. Closing it hides that
// one lighting: the key pairs the climb with its server-stamped `sentAt`, so a
// different climb, or the same climb lit again, brings the strip back.
//
// Persisted (AsyncStorage via preference-store, device-global) so a stale strip
// stays closed across launches. Same module-store shape as
// grade-format-preference.ts: one load, one subscription per consumer, and a
// snapshot rebuilt only in notify() so getSnapshot stays referentially stable.

const STORAGE_KEY = 'wallStripDismissedLighting';

type DismissalSnapshot = { dismissedKey: string | null; loaded: boolean };

let current: string | null = null;
let hasLoaded = false;
let snapshot: DismissalSnapshot = { dismissedKey: current, loaded: hasLoaded };
const listeners = new Set<() => void>();
const SERVER_SNAPSHOT: DismissalSnapshot = { dismissedKey: null, loaded: false };

/** One lighting of one climb on the wall. */
export function wallLightingKey(climb: Pick<BoardPresenceClimb, 'climbUuid' | 'sentAt'>): string {
  return `${climb.climbUuid}@${climb.sentAt}`;
}

function notify(): void {
  snapshot = { dismissedKey: current, loaded: hasLoaded };
  for (const listener of listeners) listener();
}

async function loadDismissedLighting(): Promise<string | null> {
  if (hasLoaded) return current;
  const stored = await getPreference<string>(STORAGE_KEY);
  // A dismiss may have raced in while storage was read; keep the newer choice.
  if (hasLoaded) return current;
  current = typeof stored === 'string' ? stored : null;
  hasLoaded = true;
  notify();
  return current;
}

let loadPromise: Promise<string | null> | null = null;
function ensureLoaded(): Promise<string | null> {
  if (!loadPromise) {
    loadPromise = loadDismissedLighting().catch((error: unknown) => {
      // Clear the singleton so the next mount retries (see preference-store).
      loadPromise = null;
      throw error;
    });
  }
  return loadPromise;
}

export async function dismissWallLighting(key: string): Promise<void> {
  current = key;
  hasLoaded = true;
  notify();
  await setPreference(STORAGE_KEY, key);
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): DismissalSnapshot {
  return snapshot;
}

function getServerSnapshot(): DismissalSnapshot {
  return SERVER_SNAPSHOT;
}

/**
 * The wall climb to show on the strip, or `null` when there is none or the
 * climber closed this lighting. Also `null` until the stored choice has loaded,
 * so a closed strip never flashes up on launch.
 */
export function useUndismissedWallClimb(wallClimb: BoardPresenceClimb | null): {
  wallClimb: BoardPresenceClimb | null;
  dismiss: () => void;
} {
  const { dismissedKey, loaded } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    ensureLoaded().catch(() => {});
  }, []);

  const lightingKey = wallClimb ? wallLightingKey(wallClimb) : null;
  const dismiss = useCallback(() => {
    if (lightingKey) void dismissWallLighting(lightingKey).catch(() => {});
  }, [lightingKey]);

  const visible = wallClimb !== null && loaded && dismissedKey !== lightingKey;
  return { wallClimb: visible ? wallClimb : null, dismiss };
}

/** Test-only: reset the module store between tests. */
export function resetWallStripDismissalForTests(): void {
  current = null;
  hasLoaded = false;
  loadPromise = null;
  notify();
}
