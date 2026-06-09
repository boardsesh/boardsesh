import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from './preference-store';

// Whether the user has opted in to PostHog session recording. OFF by default —
// nothing records until the climber flips the diagnostics toggle themselves
// (we surface it for people hitting Bluetooth issues). Persisted so the choice
// survives restarts; the value is restored and applied at app startup.
//
// Structure mirrors `grade-format-preference.ts`: a module-level store read via
// `useSyncExternalStore` with a referentially-stable cached snapshot (rebuilt
// only inside `notify()`), plus a promise-singleton one-time load so any number
// of mounted consumers trigger the AsyncStorage read exactly once.
const STORAGE_KEY = 'sessionRecordingEnabled';

type SessionRecordingSnapshot = { enabled: boolean; loaded: boolean };

let current = false;
let hasLoaded = false;
let snapshot: SessionRecordingSnapshot = { enabled: current, loaded: hasLoaded };
const listeners = new Set<() => void>();

const SERVER_SNAPSHOT: SessionRecordingSnapshot = { enabled: false, loaded: false };

function notify(): void {
  snapshot = { enabled: current, loaded: hasLoaded };
  for (const listener of listeners) listener();
}

export async function loadSessionRecordingEnabled(): Promise<boolean> {
  if (hasLoaded) return current;
  const stored = await getPreference<boolean>(STORAGE_KEY);
  // A `setSessionRecordingEnabledPreference` may have raced in while we awaited
  // storage; honour the user's choice over the (now stale) persisted value.
  if (hasLoaded) return current;
  current = stored === true;
  hasLoaded = true;
  notify();
  return current;
}

export async function setSessionRecordingEnabledPreference(enabled: boolean): Promise<void> {
  current = enabled;
  hasLoaded = true;
  notify();
  await setPreference(STORAGE_KEY, enabled);
}

let loadPromise: Promise<boolean> | null = null;
function ensureSessionRecordingLoaded(): Promise<boolean> {
  if (!loadPromise) {
    loadPromise = loadSessionRecordingEnabled().catch((error: unknown) => {
      // A failed read (e.g. an AsyncStorage error) must not leave a rejected
      // promise cached — clear the singleton so the next mount retries instead
      // of staying stuck at the default until the app restarts.
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

function getSnapshot(): SessionRecordingSnapshot {
  return snapshot;
}

function getServerSnapshot(): SessionRecordingSnapshot {
  return SERVER_SNAPSHOT;
}

export function useSessionRecordingPreference(): {
  enabled: boolean;
  loaded: boolean;
  setEnabled: (enabled: boolean) => void;
} {
  const { enabled, loaded } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    // Swallow read failures here — the load already clears its cached promise so
    // a later mount retries; nothing to do at this call site.
    ensureSessionRecordingLoaded().catch(() => {});
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    void setSessionRecordingEnabledPreference(next);
  }, []);

  return { enabled, loaded, setEnabled };
}
