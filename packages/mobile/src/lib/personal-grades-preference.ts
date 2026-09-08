import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from './preference-store';

// Whether the grade a climber gave a climb outranks the crowd's, everywhere the
// app shows one (#4796, #4828) — the climb row, the play drawer header, the
// Grades section, and the grade filter and difficulty sort.
//
// This is USER CONFIG, not a feature gate. The `personal-grades` PostHog flag
// supplies only the DEFAULT for climbers who have never touched the setting; an
// explicit choice always wins over it, in either direction. See
// `usePersonalGradesActive` in hooks/use-personal-grades.ts for the resolution.
//
// The stored value is therefore TRI-state, unlike its sibling
// `boardsesh-grades-preference.ts`: `null` means "never chosen", which is a
// different thing from a stored `false`, because only the former defers to the
// flag. Collapsing the two would make a deliberate opt-out silently reversible
// by a flag change.
//
// Structure otherwise mirrors that sibling: a module-level store read via
// `useSyncExternalStore` with a referentially-stable cached snapshot (rebuilt
// only inside `notify()`), plus a promise-singleton one-time load so any number
// of mounted consumers trigger the AsyncStorage read exactly once.
const STORAGE_KEY = 'usePersonalGrades';

type PersonalGradesSnapshot = {
  /** The climber's explicit choice, or `null` when they have never made one. */
  choice: boolean | null;
  loaded: boolean;
};

let current: boolean | null = null;
let hasLoaded = false;
let snapshot: PersonalGradesSnapshot = { choice: current, loaded: hasLoaded };
const listeners = new Set<() => void>();

const SERVER_SNAPSHOT: PersonalGradesSnapshot = { choice: null, loaded: false };

function notify(): void {
  snapshot = { choice: current, loaded: hasLoaded };
  for (const listener of listeners) listener();
}

export async function loadPersonalGradesPreference(): Promise<boolean | null> {
  if (hasLoaded) return current;
  const stored = await getPreference<boolean>(STORAGE_KEY);
  // A `setPersonalGradesPreference` may have raced in while we awaited storage;
  // honour the climber's choice over the (now stale) persisted value.
  if (hasLoaded) return current;
  // Anything that is not an explicit boolean reads as "never chosen", so the
  // flag default applies.
  current = typeof stored === 'boolean' ? stored : null;
  hasLoaded = true;
  notify();
  return current;
}

export async function setPersonalGradesPreference(enabled: boolean): Promise<void> {
  current = enabled;
  hasLoaded = true;
  notify();
  await setPreference(STORAGE_KEY, enabled);
}

let loadPromise: Promise<boolean | null> | null = null;
function ensurePersonalGradesLoaded(): Promise<boolean | null> {
  if (!loadPromise) {
    loadPromise = loadPersonalGradesPreference().catch((error: unknown) => {
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

function getSnapshot(): PersonalGradesSnapshot {
  return snapshot;
}

function getServerSnapshot(): PersonalGradesSnapshot {
  return SERVER_SNAPSHOT;
}

export function usePersonalGradesPreference(): {
  choice: boolean | null;
  loaded: boolean;
  setEnabled: (enabled: boolean) => void;
} {
  const { choice, loaded } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    // Swallow read failures here — the load already clears its cached promise so
    // a later mount retries; nothing to do at this call site.
    ensurePersonalGradesLoaded().catch(() => {});
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    void setPersonalGradesPreference(next);
  }, []);

  return { choice, loaded, setEnabled };
}

/** Test-only: drop the cached load so a suite can start from a clean store. */
export function resetPersonalGradesPreferenceForTests(): void {
  current = null;
  hasLoaded = false;
  loadPromise = null;
  notify();
}
