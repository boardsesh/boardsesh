// Local persistence for the SOLO queue — the queue you build without a
// session. Server sessions own their queue (the FullSync on join re-hydrates
// it), so this store is only written while no session is active and is cleared
// the moment queue ownership moves to a session (explicit start seeds the
// server; joins replace the local queue with the server snapshot).
//
// Backed by **unsecure** AsyncStorage via preference-store, not SecureStore:
// a queue of climbs is non-secret and routinely larger than SecureStore's
// 2 KB per-value limit.
//
// Schema migration note: `getPreference` silently returns null when JSON.parse
// fails, but a stale value whose shape no longer matches `LocalQueueSnapshot`
// will parse successfully and be cast to the wrong type. Bump the key suffix
// when the shape changes so stale values are ignored rather than misread.

import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { getPreference, setPreference, removePreference } from './preference-store';

const QUEUE_SNAPSHOT_KEY = 'boardsesh_local_queue_snapshot_v1';

/**
 * `playlistSuggestionSource.climbs` can hold an entire ordered board list
 * (the activation refresh pages the whole playlist). Android's AsyncStorage
 * caps a single entry around 2 MB, so the persisted source keeps a window of
 * climbs around the activated one. Degraded restore = the queue comes back,
 * swiping through the rest of the playlist doesn't.
 */
const MAX_PERSISTED_SUGGESTION_CLIMBS = 100;

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

export function getStoredQueueSnapshot(): Promise<LocalQueueSnapshot | null> {
  return getPreference<LocalQueueSnapshot>(QUEUE_SNAPSHOT_KEY);
}

export function setStoredQueueSnapshot(snapshot: Omit<LocalQueueSnapshot, 'savedAt'>): Promise<void> {
  return setPreference<LocalQueueSnapshot>(QUEUE_SNAPSHOT_KEY, {
    ...snapshot,
    playlistSuggestionSource: capSuggestionSource(snapshot.playlistSuggestionSource),
    savedAt: new Date().toISOString(),
  });
}

export function clearStoredQueueSnapshot(): Promise<void> {
  return removePreference(QUEUE_SNAPSHOT_KEY);
}
