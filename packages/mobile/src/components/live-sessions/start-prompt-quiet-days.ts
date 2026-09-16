// "Quiet days" for the rail's Start tile. A prompt nobody taps for days is
// wallpaper, so after impressions on 3 distinct days without a tap, and while
// nobody is live, the tile shrinks to a 56pt row. A tap, a live session showing
// up, or a Bluetooth connect starts the count again.
//
// Singleton + `useSyncExternalStore`, the same shape as `section-expand-store`,
// persisted through the shared AsyncStorage preference store.

import { useEffect, useSyncExternalStore } from 'react';
import { getPreference, setPreference } from '../../lib/preference-store';

export const START_PROMPT_STORAGE_KEY = 'liveSessionsStartPromptImpressionDays';
export const START_PROMPT_QUIET_DAYS = 3;
/** Only the most recent days matter; cap what gets persisted. */
const MAX_STORED_DAYS = 7;

type Snapshot = { days: readonly string[]; loaded: boolean };

let days: readonly string[] = [];
let hasLoaded = false;
let snapshot: Snapshot = { days, loaded: hasLoaded };
const listeners = new Set<() => void>();
const SERVER_SNAPSHOT: Snapshot = { days: [], loaded: false };

function notify(): void {
  snapshot = { days, loaded: hasLoaded };
  for (const listener of listeners) listener();
}

function persist(): void {
  void setPreference(START_PROMPT_STORAGE_KEY, days).catch(() => {
    // Best-effort, like every UI preference: the in-memory value still holds.
  });
}

function isDayList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

let loadPromise: Promise<void> | null = null;
function ensureLoaded(): Promise<void> {
  if (hasLoaded) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = getPreference<unknown>(START_PROMPT_STORAGE_KEY)
      .then((stored) => {
        if (hasLoaded) return;
        days = isDayList(stored) ? stored.slice(-MAX_STORED_DAYS) : [];
        hasLoaded = true;
        notify();
      })
      .catch(() => {
        // A failed read (locked keychain-backed storage on a background launch)
        // must be retryable, not cached as "no impressions".
        loadPromise = null;
      });
  }
  return loadPromise;
}

/** Local calendar day, `YYYY-MM-DD`. A climber's "day" is their own midnight. */
export function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Collapsed once the prompt was ignored on enough EARLIER days. Today does not
 * count, so the tile never shrinks under the climber's eyes on the day that
 * tips the threshold.
 */
export function isStartPromptCollapsed(storedDays: readonly string[], today: string): boolean {
  return storedDays.filter((day) => day !== today).length >= START_PROMPT_QUIET_DAYS;
}

export function recordStartPromptImpression(today: string): void {
  if (days.includes(today)) return;
  days = [...days, today].slice(-MAX_STORED_DAYS);
  hasLoaded = true;
  notify();
  persist();
}

export function resetStartPromptImpressions(): void {
  if (days.length === 0) return;
  days = [];
  hasLoaded = true;
  notify();
  persist();
}

export function resetStartPromptStoreForTests(): void {
  days = [];
  hasLoaded = false;
  snapshot = { days, loaded: hasLoaded };
  loadPromise = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Snapshot {
  return snapshot;
}

function getServerSnapshot(): Snapshot {
  return SERVER_SNAPSHOT;
}

export function useStartPromptImpressions(): Snapshot {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    void ensureLoaded();
  }, []);
  return current;
}
