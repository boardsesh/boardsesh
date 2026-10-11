import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from './preference-store';

// Whether to render the data-science "Boardsesh grade" in place of the legacy
// Aurora-set grade across the app (play drawer, climb lists, logbook). Opt-in:
// the default is OFF, so grades look unchanged until a climber turns it on
// from More → Display. Gated behind the `boardsesh-grade` PostHog flag on top
// of this preference — see `useBoardseshGradesActive` in
// hooks/use-display-grade.ts (flag off is a hard kill switch even over a
// stale persisted preference).
//
// Structure mirrors `session-recording-preference.ts`: a module-level store
// read via `useSyncExternalStore` with a referentially-stable cached snapshot
// (rebuilt only inside `notify()`), plus a promise-singleton one-time load so
// any number of mounted consumers trigger the AsyncStorage read exactly once.
const STORAGE_KEY = 'useBoardseshGrades';
const DEFAULT_USE_BOARDSESH_GRADES = false;

type BoardseshGradesSnapshot = { enabled: boolean; loaded: boolean };

let current = DEFAULT_USE_BOARDSESH_GRADES;
let hasLoaded = false;
let snapshot: BoardseshGradesSnapshot = { enabled: current, loaded: hasLoaded };
const listeners = new Set<() => void>();

const SERVER_SNAPSHOT: BoardseshGradesSnapshot = { enabled: DEFAULT_USE_BOARDSESH_GRADES, loaded: false };

function notify(): void {
  snapshot = { enabled: current, loaded: hasLoaded };
  for (const listener of listeners) listener();
}

export async function loadBoardseshGradesPreference(): Promise<boolean> {
  if (hasLoaded) return current;
  const stored = await getPreference<boolean>(STORAGE_KEY);
  // A `setBoardseshGradesPreference` may have raced in while we awaited
  // storage; honour the user's choice over the (now stale) persisted value.
  if (hasLoaded) return current;
  // An explicit stored choice (true/false) wins; an absent value falls back to
  // OFF so Boardsesh grades are opt-in only.
  current = typeof stored === 'boolean' ? stored : DEFAULT_USE_BOARDSESH_GRADES;
  hasLoaded = true;
  notify();
  return current;
}

export async function setBoardseshGradesPreference(enabled: boolean): Promise<void> {
  current = enabled;
  hasLoaded = true;
  notify();
  await setPreference(STORAGE_KEY, enabled);
}

let loadPromise: Promise<boolean> | null = null;
function ensureBoardseshGradesLoaded(): Promise<boolean> {
  if (!loadPromise) {
    loadPromise = loadBoardseshGradesPreference().catch((error: unknown) => {
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

function getSnapshot(): BoardseshGradesSnapshot {
  return snapshot;
}

function getServerSnapshot(): BoardseshGradesSnapshot {
  return SERVER_SNAPSHOT;
}

export function useBoardseshGradesPreference(): {
  enabled: boolean;
  loaded: boolean;
  setEnabled: (enabled: boolean) => void;
} {
  const { enabled, loaded } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    // Swallow read failures here — the load already clears its cached promise so
    // a later mount retries; nothing to do at this call site.
    ensureBoardseshGradesLoaded().catch(() => {});
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    void setBoardseshGradesPreference(next);
  }, []);

  return { enabled, loaded, setEnabled };
}
