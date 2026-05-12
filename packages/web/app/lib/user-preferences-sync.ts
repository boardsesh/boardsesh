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
  getLastSyncPulledAt,
  getPreferenceMeta,
  getSyncQueueSnapshot,
  registerSyncableKeys,
  removePreferenceFromServer,
  setLastSyncPulledAt,
  setPreference,
  setPreferenceFromServer,
  updateSyncQueueEntryAttempts,
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
 * Time-box the initial pull. A stalled GraphQL round-trip at auth time would
 * otherwise block every downstream preference write — when the request hangs
 * we'd rather drop into the offline-queue path and try again later.
 */
const PULL_INITIAL_TIMEOUT_MS = 5_000;

const withTimeout = <T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`[user-preferences-sync] ${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([work, timeoutPromise]).finally(() => {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  });
};

/**
 * Pull every server-side preference, resolve conflicts against the local
 * meta timestamp (newer wins), then reconcile local-only preferences with
 * the help of a `lastPulledAt` watermark to distinguish:
 *
 *  - "Server deleted this key on another device" — local pref was last
 *    touched at or before the previous successful pull, and the server
 *    doesn't have it now. Drop locally without enqueueing — otherwise
 *    we'd undo the remote deletion on every login.
 *
 *  - "Brand-new local change the server hasn't seen yet" — local pref was
 *    touched AFTER the previous successful pull, or no previous pull has
 *    happened on this device. Push the value up via the normal
 *    setPreference path so it lands on the server.
 *
 * Finally drains the queue so any brand-new writes ride the same
 * authenticated round-trip.
 */
export async function pullInitial(authToken: string): Promise<void> {
  if (!authToken) return;

  let response: GetUserPreferencesQueryResponse;
  try {
    response = await withTimeout(
      executeGraphQL<GetUserPreferencesQueryResponse>(GET_USER_PREFERENCES, undefined, authToken),
      PULL_INITIAL_TIMEOUT_MS,
      'pullInitial GET',
    );
  } catch (error) {
    console.warn('[user-preferences-sync] pullInitial GET failed:', error);
    return;
  }

  const previousPulledAt = await getLastSyncPulledAt();
  const nowForPull = Date.now();

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

  // Reconcile keys present locally but absent on the server.
  const localSyncable = await getAllSyncablePreferences();
  for (const localEntry of localSyncable) {
    if (serverKeys.has(localEntry.key)) continue;

    const localMeta = await getPreferenceMeta(localEntry.key);
    const localUpdatedAt = localMeta?.updatedAt ?? 0;

    if (previousPulledAt > 0 && localUpdatedAt <= previousPulledAt) {
      // The server had this key the last time we successfully pulled and
      // now doesn't — another device deleted it. Honor the deletion
      // locally without re-enqueueing it.
      await removePreferenceFromServer(localEntry.key);
    } else {
      // Either this is the first pull this device has ever done (we can't
      // tell apart a fresh-install local pref from a server-deleted one,
      // so default to "keep + push"), or the local pref was written after
      // the previous pull and the server hasn't seen it yet. Push it up.
      await setPreference(localEntry.key, localEntry.value as never);
    }
  }

  await setLastSyncPulledAt(nowForPull);

  await pushQueueFlush(authToken);
}

/**
 * Maximum times a single queue entry will be retried before being dropped.
 * Prevents a single poison entry (e.g. malformed value the server rejects
 * deterministically) from starving the queue indefinitely.
 */
const MAX_QUEUE_ENTRY_ATTEMPTS = 5;

/**
 * Drain pending sync ops to the server in FIFO order. On per-entry failure
 * we increment that entry's attempts counter and skip past it so later
 * entries can still flush — the next `online` event or `pullInitial` retries
 * the failed entry. After `MAX_QUEUE_ENTRY_ATTEMPTS` failures we drop the
 * poison entry with a warning rather than blocking the queue forever.
 */
export async function pushQueueFlush(authToken: string): Promise<void> {
  if (!authToken) return;

  const snapshot = await getSyncQueueSnapshot();
  for (const entry of snapshot) {
    const succeeded = await sendQueueEntry(entry, authToken);
    if (succeeded) {
      await deleteSyncQueueEntry(entry.id);
      continue;
    }

    const previousAttempts = entry.attempts ?? 0;
    const nextAttempts = previousAttempts + 1;
    if (nextAttempts >= MAX_QUEUE_ENTRY_ATTEMPTS) {
      console.warn(
        `[user-preferences-sync] dropping poison queue entry after ${nextAttempts} attempts:`,
        entry.op,
        entry.key,
      );
      await deleteSyncQueueEntry(entry.id);
      continue;
    }
    await updateSyncQueueEntryAttempts(entry.id, nextAttempts);
    // Continue to the next entry — earlier behaviour returned here, which let
    // a single failing entry block every later write indefinitely.
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
