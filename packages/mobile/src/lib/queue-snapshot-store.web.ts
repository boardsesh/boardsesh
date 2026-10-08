import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { getPreference, removePreference, setPreference } from './preference-store';
import { createQueueSnapshotWriteLane } from './queue-snapshot-write-lane';
import { sanitizeQueueSnapshot } from './queue-privacy';
import type { UserStorageOwner } from './user-storage-owner';
import { userScopedStorageKey } from './user-storage-owner.web';

const QUEUE_SNAPSHOT_KEY = 'boardsesh_local_queue_snapshot_v1';
// Queue lifecycle generations are global, matching native: a clear fences old
// callbacks across account transitions, while storage keys remain owner-scoped.
const snapshotWriteLane = createQueueSnapshotWriteLane();

export const getQueueSnapshotGeneration = snapshotWriteLane.getGeneration;
export const invalidateStoredQueueSnapshot = snapshotWriteLane.invalidate;

export type LocalQueueSnapshot = {
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  /** ISO 8601 write timestamp, for debugging stale restores. */
  savedAt: string;
};

export async function getStoredQueueSnapshot(owner?: UserStorageOwner | null): Promise<LocalQueueSnapshot | null> {
  const storageKey = userScopedStorageKey(QUEUE_SNAPSHOT_KEY, owner);
  const snapshot = storageKey ? await getPreference<LocalQueueSnapshot>(storageKey) : null;
  return snapshot ? sanitizeQueueSnapshot(snapshot) : null;
}

export function setStoredQueueSnapshot(
  snapshot: Omit<LocalQueueSnapshot, 'savedAt'>,
  owner?: UserStorageOwner | null,
  expectedGeneration = getQueueSnapshotGeneration(),
): Promise<void> {
  const storageKey = userScopedStorageKey(QUEUE_SNAPSHOT_KEY, owner);
  if (!storageKey) return Promise.resolve();
  const references: LocalQueueSnapshot = {
    ...sanitizeQueueSnapshot(snapshot),
    savedAt: new Date().toISOString(),
  };
  return snapshotWriteLane.write(() => setPreference(storageKey, references), expectedGeneration);
}

export function clearStoredQueueSnapshot(owner?: UserStorageOwner | null): Promise<void> {
  const storageKey = userScopedStorageKey(QUEUE_SNAPSHOT_KEY, owner);
  return snapshotWriteLane.clear(() => (storageKey ? removePreference(storageKey) : Promise.resolve()));
}
