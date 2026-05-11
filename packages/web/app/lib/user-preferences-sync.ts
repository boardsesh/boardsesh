/**
 * User-preference sync engine — owns the "pull on auth", "push the local
 * queue", and "drain queue when we come back online" flows. The IDB
 * primitives live in `./user-preferences-db`; this file is the orchestrator
 * the React provider and any imperative call sites talk to.
 *
 * Wire:
 *   pullInitial    — server -> local (with conflict resolution by timestamp)
 *                    + push any local entries the server doesn't know about
 *   pushQueueFlush — drain pending writes from the sync_queue to the server
 *   setupAutoFlush — hook the browser `online` event so we retry on recovery
 */

import { executeGraphQL } from './graphql/client';
import {
  DELETE_USER_PREFERENCE,
  GET_USER_PREFERENCES,
  SET_USER_PREFERENCE,
  type DeleteUserPreferenceMutationResponse,
  type DeleteUserPreferenceMutationVariables,
  type GetUserPreferencesQueryResponse,
  type SetUserPreferenceMutationResponse,
  type SetUserPreferenceMutationVariables,
} from './graphql/operations/user-preferences';
import {
  deleteSyncQueueEntry,
  getAllSyncablePreferences,
  getPreferenceMeta,
  getSyncQueueSnapshot,
  registerSyncableKeys,
  setPreference,
  setPreferenceFromServer,
  type SyncQueueSnapshotEntry,
  type UserPreferenceKeyMap,
} from './user-preferences-db';

/**
 * Keys that participate in cross-device sync. Anything NOT in this set
 * stays purely client-side — `esp32Connections` is the canonical example
 * because the entries are LAN IPs that only make sense on one device.
 */
export const SYNCABLE_KEYS: ReadonlySet<keyof UserPreferenceKeyMap> = new Set<keyof UserPreferenceKeyMap>([
  'libraryTab',
  'logbookPreferences',
  'swipeHint:climbListSeen',
  'swipeHint:queueBarSeen',
  'swipeHint:logbookSeen',
  'tickBarExpanded',
  'shakeToReport:dismissed',
  'consent',
]);

// Tell the IDB layer which keys to enqueue when written. The IDB module
// can't import this file directly without forming a cycle, so we register
// the matcher at load time. This module is imported by the sync provider
// which runs before any preference writes the user might trigger.
registerSyncableKeys((key: string): boolean => SYNCABLE_KEYS.has(key as keyof UserPreferenceKeyMap));

const parseServerTimestamp = (raw: string): number => {
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Pull every server-side preference, resolve conflicts against the local
 * meta timestamp (newer wins), then push any local syncable preferences
 * the server doesn't yet know about. Finally drains the queue so any
 * brand-new writes ride the same authenticated round-trip.
 */
export async function pullInitial(authToken: string): Promise<void> {
  if (!authToken) return;

  let response: GetUserPreferencesQueryResponse;
  try {
    response = await executeGraphQL<GetUserPreferencesQueryResponse>(GET_USER_PREFERENCES, undefined, authToken);
  } catch (error) {
    console.warn('[user-preferences-sync] pullInitial GET failed:', error);
    return;
  }

  const serverEntries = response.userPreferences ?? [];
  const serverKeys = new Set<string>();

  for (const serverEntry of serverEntries) {
    serverKeys.add(serverEntry.key);
    if (!SYNCABLE_KEYS.has(serverEntry.key as keyof UserPreferenceKeyMap)) continue;
    const serverUpdatedAt = parseServerTimestamp(serverEntry.updatedAt);
    const localMeta = await getPreferenceMeta(serverEntry.key);
    const localUpdatedAt = localMeta?.updatedAt ?? 0;
    if (serverUpdatedAt > localUpdatedAt) {
      await setPreferenceFromServer(serverEntry.key, serverEntry.value, serverUpdatedAt);
    }
  }

  // Orphan local preferences — present locally, absent on server — must be
  // pushed up. We re-route them through setPreference so the standard write
  // path (meta + queue + broadcast) does the bookkeeping.
  const localSyncable = await getAllSyncablePreferences();
  for (const localEntry of localSyncable) {
    if (serverKeys.has(localEntry.key)) continue;
    await setPreference(localEntry.key, localEntry.value as never);
  }

  await pushQueueFlush(authToken);
}

/**
 * Drain pending sync ops to the server in FIFO order. Stops on the first
 * failure and leaves the rest queued for the next flush — the next online
 * event or pullInitial will pick them back up.
 */
export async function pushQueueFlush(authToken: string): Promise<void> {
  if (!authToken) return;

  const snapshot = await getSyncQueueSnapshot();
  for (const entry of snapshot) {
    const succeeded = await sendQueueEntry(entry, authToken);
    if (!succeeded) {
      // Stop here — leave this entry and everything after it queued for retry.
      return;
    }
    await deleteSyncQueueEntry(entry.id);
  }
}

const sendQueueEntry = async (entry: SyncQueueSnapshotEntry, authToken: string): Promise<boolean> => {
  try {
    if (entry.op === 'set') {
      await executeGraphQL<SetUserPreferenceMutationResponse, SetUserPreferenceMutationVariables>(
        SET_USER_PREFERENCE,
        { input: { key: entry.key, value: entry.value } },
        authToken,
      );
    } else {
      await executeGraphQL<DeleteUserPreferenceMutationResponse, DeleteUserPreferenceMutationVariables>(
        DELETE_USER_PREFERENCE,
        { key: entry.key },
        authToken,
      );
    }
    return true;
  } catch (error) {
    console.warn(`[user-preferences-sync] queue flush failed at ${entry.op} ${entry.key}:`, error);
    return false;
  }
};

/**
 * Register an `online` listener that drains the queue with the supplied
 * token getter. Returns a cleanup function. Safe to call during SSR — it
 * no-ops when `window` is undefined.
 */
export function setupAutoFlush(getAuthToken: () => string | null): () => void {
  if (typeof window === 'undefined') return () => {};

  const handler = () => {
    const token = getAuthToken();
    if (!token) return;
    void pushQueueFlush(token);
  };

  window.addEventListener('online', handler);
  return () => {
    window.removeEventListener('online', handler);
  };
}
