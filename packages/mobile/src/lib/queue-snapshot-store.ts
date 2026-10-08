// Local persistence for the SOLO queue — the queue you build without a
// session. Server sessions own their queue (the FullSync on join re-hydrates
// it), so this store is only written while no session is active and is cleared
// the moment queue ownership moves to a session (explicit start seeds the
// server; joins replace the local queue with the server snapshot).
//
// Backed by **unsecure** AsyncStorage via preference-store, not SecureStore:
// only opaque climb references and queue order belong here. Climb details and
// attribution must be fetched again under the current viewer's access.
//
// Schema migration note: `getPreference` silently returns null when JSON.parse
// fails, but a stale value whose shape no longer matches `LocalQueueSnapshot`
// will parse successfully and be cast to the wrong type. Bump the key suffix
// when the shape changes so stale values are ignored rather than misread.

import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { sanitizeQueueSnapshot } from './queue-privacy';
import { getPreference, setPreference, removePreference } from './preference-store';
import { createQueueSnapshotWriteLane } from './queue-snapshot-write-lane';
import type { UserStorageOwner } from './user-storage-owner';

const QUEUE_SNAPSHOT_KEY = 'boardsesh_local_queue_snapshot_v1';

export type LocalQueueSnapshot = {
  queue: ClimbQueueItem[];
  currentClimbQueueItem: ClimbQueueItem | null;
  playlistSuggestionSource: PlaylistSuggestionSource | null;
  /** ISO 8601 write timestamp, for debugging stale restores. */
  savedAt: string;
  /** Native snapshots predate account scoping; legacy references can be adopted. */
  ownerUserId?: string | null;
};

export async function getStoredQueueSnapshot(owner?: UserStorageOwner | null): Promise<LocalQueueSnapshot | null> {
  const snapshot = await getPreference<LocalQueueSnapshot>(QUEUE_SNAPSHOT_KEY);
  if (!snapshot) return null;
  if (snapshot.ownerUserId && snapshot.ownerUserId !== owner?.userId) return null;
  // An unowned legacy queue keeps its references, never its copied content.
  return sanitizeQueueSnapshot(snapshot);
}

const snapshotWriteLane = createQueueSnapshotWriteLane();

export const getQueueSnapshotGeneration = snapshotWriteLane.getGeneration;
export const invalidateStoredQueueSnapshot = snapshotWriteLane.invalidate;

export function setStoredQueueSnapshot(
  snapshot: Omit<LocalQueueSnapshot, 'savedAt'>,
  owner?: UserStorageOwner | null,
  expectedGeneration = getQueueSnapshotGeneration(),
): Promise<void> {
  const references: LocalQueueSnapshot = {
    ...sanitizeQueueSnapshot(snapshot),
    ownerUserId: owner?.userId ?? null,
    savedAt: new Date().toISOString(),
  };
  return snapshotWriteLane.write(() => setPreference(QUEUE_SNAPSHOT_KEY, references), expectedGeneration);
}

export function clearStoredQueueSnapshot(_owner?: UserStorageOwner | null): Promise<void> {
  return snapshotWriteLane.clear(() => removePreference(QUEUE_SNAPSHOT_KEY));
}
