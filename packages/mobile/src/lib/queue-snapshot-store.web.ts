import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { getPreference, removePreference, setPreference } from './preference-store';
import { createQueueSnapshotWriteLane } from './queue-snapshot-write-lane';
import type { UserStorageOwner } from './user-storage-owner';
import { userScopedStorageKey } from './user-storage-owner.web';

const QUEUE_SNAPSHOT_KEY = 'boardsesh_local_queue_snapshot_v1';
const MAX_PERSISTED_SUGGESTION_CLIMBS = 100;
// Queue lifecycle generations are global, matching native: a clear fences old
// callbacks across account transitions, while storage keys remain owner-scoped.
const snapshotWriteLane = createQueueSnapshotWriteLane();

export const getQueueSnapshotGeneration = snapshotWriteLane.getGeneration;

export type LocalQueueSnapshot = {
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  /** ISO 8601 write timestamp, for debugging stale restores. */
  savedAt: string;
};

function capSuggestionSource(source: PlaylistSuggestionSource | null): PlaylistSuggestionSource | null {
  if (!source || source.climbs.length <= MAX_PERSISTED_SUGGESTION_CLIMBS) return source;
  const activatedIndex = source.climbs.findIndex((climb) => climb.uuid === source.activatedClimbUuid);
  const windowStart = Math.max(0, (activatedIndex === -1 ? 0 : activatedIndex) - MAX_PERSISTED_SUGGESTION_CLIMBS / 2);
  return { ...source, climbs: source.climbs.slice(windowStart, windowStart + MAX_PERSISTED_SUGGESTION_CLIMBS) };
}

export function getStoredQueueSnapshot(owner?: UserStorageOwner | null): Promise<LocalQueueSnapshot | null> {
  const storageKey = userScopedStorageKey(QUEUE_SNAPSHOT_KEY, owner);
  return storageKey ? getPreference<LocalQueueSnapshot>(storageKey) : Promise.resolve(null);
}

export function setStoredQueueSnapshot(
  snapshot: Omit<LocalQueueSnapshot, 'savedAt'>,
  owner?: UserStorageOwner | null,
  expectedGeneration = getQueueSnapshotGeneration(),
): Promise<void> {
  const storageKey = userScopedStorageKey(QUEUE_SNAPSHOT_KEY, owner);
  if (!storageKey) return Promise.resolve();
  return snapshotWriteLane.write(
    () =>
      setPreference<LocalQueueSnapshot>(storageKey, {
        ...snapshot,
        playlistSuggestionSource: capSuggestionSource(snapshot.playlistSuggestionSource),
        savedAt: new Date().toISOString(),
      }),
    expectedGeneration,
  );
}

export function clearStoredQueueSnapshot(owner?: UserStorageOwner | null): Promise<void> {
  const storageKey = userScopedStorageKey(QUEUE_SNAPSHOT_KEY, owner);
  return snapshotWriteLane.clear(() => (storageKey ? removePreference(storageKey) : Promise.resolve()));
}
