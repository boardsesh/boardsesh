import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from './preference-store';

// Diagnostic toggles for the Android-16 / Pixel-10 climb-list touch-freeze
// investigation. Each flag, when ON, disables or alters ONE suspected cause so a
// tester can bisect on a real affected device which change restores scrolling —
// the two ActiveContextBar fixes (#3060 split, #3104 drop-entering-on-Android)
// both missed, so the culprit has to be pinned on-device, not guessed again.
//
// Surfaced only to admin-granted testers / dev builds via FreezeDebugPanel, and
// this branch ships only to the diagnostic OTA channel (never production) — all
// flags default OFF, so a regular user can never enter a diagnostic state.
// Structure mirrors `session-recording-preference.ts`: a module-level store
// read via `useSyncExternalStore` with a referentially-stable cached snapshot, plus
// a promise-singleton one-time load.

export type FreezeDebugFlag =
  /** PersistentQueueBar returns null — rules the queue/ActiveContextBar in or out. */
  | 'hideQueueBar'
  /** Don't mount the always-on gorhom QueueSheet/BoardSheet — tests a closed-sheet
   *  container swallowing touches on Android 16. */
  | 'unmountSheets'
  /** Render the climb list with a plain RN FlatList instead of FlashList v2 —
   *  isolates a FlashList v2 scroll/measure regression. */
  | 'useFlatList'
  /** Drop the per-row ReanimatedSwipeable wrapper — tests a horizontal-pan gesture
   *  stealing the vertical scroll ("horizontal swipe works, vertical dead"). */
  | 'disableRowSwipe'
  /** Skip the absolutely-positioned ClimbTopChrome overlay — tests the Material
   *  top chrome / its measured search-bar padding. */
  | 'hideTopChrome';

export type FreezeDebugFlags = Record<FreezeDebugFlag, boolean>;

const STORAGE_KEY = 'freezeDebugFlags';

const DEFAULT_FLAGS: FreezeDebugFlags = {
  hideQueueBar: false,
  unmountSheets: false,
  useFlatList: false,
  disableRowSwipe: false,
  hideTopChrome: false,
};

const FLAG_KEYS = Object.keys(DEFAULT_FLAGS) as FreezeDebugFlag[];

type FreezeDebugSnapshot = { flags: FreezeDebugFlags; loaded: boolean };

let current: FreezeDebugFlags = DEFAULT_FLAGS;
let hasLoaded = false;
let snapshot: FreezeDebugSnapshot = { flags: current, loaded: hasLoaded };
const listeners = new Set<() => void>();

const SERVER_SNAPSHOT: FreezeDebugSnapshot = { flags: DEFAULT_FLAGS, loaded: false };

function notify(): void {
  snapshot = { flags: current, loaded: hasLoaded };
  for (const listener of listeners) listener();
}

// Keep only known keys and coerce to boolean so a malformed/stale payload can't
// inject unexpected flags or non-boolean values.
function sanitize(stored: Partial<FreezeDebugFlags> | null): FreezeDebugFlags {
  const next: FreezeDebugFlags = { ...DEFAULT_FLAGS };
  if (stored && typeof stored === 'object') {
    for (const key of FLAG_KEYS) {
      if (typeof stored[key] === 'boolean') next[key] = stored[key] as boolean;
    }
  }
  return next;
}

export async function loadFreezeDebugFlags(): Promise<FreezeDebugFlags> {
  if (hasLoaded) return current;
  // This branch's JS only ships to the diagnostic OTA channel (testers) — never the
  // production channel — and only the tester-gated panel ever writes a flag, so a
  // non-tester's store is empty and this read returns the OFF defaults regardless.
  const stored = await getPreference<Partial<FreezeDebugFlags>>(STORAGE_KEY);
  // A `setFreezeDebugFlag` may have raced in while we awaited storage; honour the
  // newer in-memory choice over the (now stale) persisted value.
  if (hasLoaded) return current;
  current = sanitize(stored);
  hasLoaded = true;
  notify();
  return current;
}

export async function setFreezeDebugFlag(flag: FreezeDebugFlag, value: boolean): Promise<void> {
  current = { ...current, [flag]: value };
  hasLoaded = true;
  notify();
  await setPreference(STORAGE_KEY, current);
}

let loadPromise: Promise<FreezeDebugFlags> | null = null;
function ensureFreezeDebugLoaded(): Promise<FreezeDebugFlags> {
  if (!loadPromise) {
    loadPromise = loadFreezeDebugFlags().catch((error: unknown) => {
      // Don't cache a rejected promise — clear the singleton so a later mount
      // retries instead of staying stuck at defaults until restart.
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

function getSnapshot(): FreezeDebugSnapshot {
  return snapshot;
}

function getServerSnapshot(): FreezeDebugSnapshot {
  return SERVER_SNAPSHOT;
}

export function useFreezeDebugFlags(): {
  flags: FreezeDebugFlags;
  loaded: boolean;
  setFlag: (flag: FreezeDebugFlag, value: boolean) => void;
} {
  const { flags, loaded } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    ensureFreezeDebugLoaded().catch(() => {});
  }, []);

  const setFlag = useCallback((flag: FreezeDebugFlag, value: boolean) => {
    void setFreezeDebugFlag(flag, value);
  }, []);

  return { flags, loaded, setFlag };
}

// Single-flag reader for consumers (queue bar, drawer host, list rows) that only
// gate on one toggle and don't need the setter.
export function useFreezeDebugFlag(flag: FreezeDebugFlag): boolean {
  const { flags } = useFreezeDebugFlags();
  return flags[flag];
}
