import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import type { BoardPresenceClimb } from '@boardsesh/shared-schema';
import { getPreference, setPreference } from './preference-store';

const STORAGE_KEY = 'wallCapsuleDismissals';

type StoredDismissals = { version: 1; byBoard: Record<string, string> };
type DismissalSnapshot = { byBoard: ReadonlyMap<number, string>; loaded: boolean };

let byBoard: ReadonlyMap<number, string> = new Map();
let loaded = false;
let snapshot: DismissalSnapshot = { byBoard, loaded };
const SERVER_SNAPSHOT: DismissalSnapshot = { byBoard: new Map(), loaded: false };
const listeners = new Set<() => void>();
// Choices made before the disk read finishes override that read, while entries
// for other boards still load. Never write an incomplete map after a read error.
const pendingDismissals = new Map<number, string>();
let loadPromise: Promise<void> | null = null;
let writePromise = Promise.resolve();
let revision = 0;
let persistedRevision = 0;
let queuedRevision = 0;

function notify(): void {
  snapshot = { byBoard, loaded };
  for (const listener of listeners) listener();
}

function readStoredDismissals(stored: unknown): Map<number, string> {
  if (stored === null || typeof stored !== 'object' || !('version' in stored) || stored.version !== 1) return new Map();
  if (!('byBoard' in stored) || stored.byBoard === null || typeof stored.byBoard !== 'object') return new Map();
  return new Map(
    Object.entries(stored.byBoard).flatMap(([boardId, occurrenceKey]) => {
      const numericBoardId = Number(boardId);
      return Number.isSafeInteger(numericBoardId) && typeof occurrenceKey === 'string'
        ? [[numericBoardId, occurrenceKey] as const]
        : [];
    }),
  );
}

function persistDismissals(): void {
  const writtenRevision = revision;
  if (writtenRevision <= queuedRevision) return;
  queuedRevision = writtenRevision;
  const stored: StoredDismissals = { version: 1, byBoard: Object.fromEntries(byBoard) };
  // Every snapshot writes after its predecessor; an older slow write cannot
  // finish last and restore a dismissed event from before the latest swipe.
  writePromise = writePromise
    .then(() => setPreference(STORAGE_KEY, stored))
    .then(() => {
      persistedRevision = writtenRevision;
    })
    .catch(() => {
      // Keep the optimistic choice and retry the newest snapshot on foreground.
      if (queuedRevision === writtenRevision) queuedRevision = persistedRevision;
    });
}

function ensureLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loadPromise === null) {
    loadPromise = getPreference<unknown>(STORAGE_KEY)
      .then((stored) => {
        byBoard = new Map([...readStoredDismissals(stored), ...pendingDismissals]);
        loaded = true;
        const needsPersist = pendingDismissals.size > 0;
        pendingDismissals.clear();
        notify();
        if (needsPersist) persistDismissals();
      })
      .catch((error: unknown) => {
        loadPromise = null;
        throw error;
      });
  }
  return loadPromise;
}

function refreshDismissals(): void {
  if (!loaded) {
    void ensureLoaded().catch(() => {});
  } else if (persistedRevision < revision) {
    persistDismissals();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): DismissalSnapshot {
  return snapshot;
}

/** A re-light of the same climb is a new occurrence, even after a board resets its sequence. */
export function wallCapsuleOccurrenceKey(boardId: number, climb: BoardPresenceClimb): string {
  return JSON.stringify([boardId, climb.seq, climb.sentAt, climb.climbUuid]);
}

/** Hide just this lighting occurrence on this device, including across launches. */
export function dismissWallCapsule(boardId: number, occurrenceKey: string): void {
  if (byBoard.get(boardId) === occurrenceKey) return;
  byBoard = new Map(byBoard).set(boardId, occurrenceKey);
  revision++;
  if (!loaded) pendingDismissals.set(boardId, occurrenceKey);
  notify();
  if (loaded) persistDismissals();
  else refreshDismissals();
}

/** Keep the capsule hidden during hydration so a stored dismissal never flashes. */
export function useWallCapsuleDismissed(
  boardId: number | null,
  occurrenceKey: string | null,
): { loaded: boolean; dismissed: boolean } {
  const currentSnapshot = useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);
  useEffect(() => {
    if (boardId === null || occurrenceKey === null) return undefined;
    refreshDismissals();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshDismissals();
    });
    return () => subscription.remove();
  }, [boardId, occurrenceKey]);
  return {
    loaded: boardId === null || occurrenceKey === null || currentSnapshot.loaded,
    dismissed: boardId !== null && occurrenceKey !== null && currentSnapshot.byBoard.get(boardId) === occurrenceKey,
  };
}

/** Test-only: simulate a cold launch while preserving the preference backing store. */
export function resetWallCapsuleDismissalsForTests(): void {
  byBoard = new Map();
  loaded = false;
  snapshot = { byBoard, loaded };
  pendingDismissals.clear();
  loadPromise = null;
  writePromise = Promise.resolve();
  revision = 0;
  persistedRevision = 0;
  queuedRevision = 0;
}
