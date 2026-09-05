import { createMMKV } from 'react-native-mmkv';
import type { UserStorageOwner } from '../user-storage-owner';

// A DEDICATED MMKV instance, not `boardsesh-settings`. Two reasons: a blob up to
// 512 KB has no business sharing the settings file, and `resetAllSettings()`
// calls `clearAll()` on that instance — which would silently take the query
// cache with it.
const storage = createMMKV({ id: 'boardsesh-query-cache' });

const CACHE_KEY = 'queryCacheV1';
const OWNER_KEY = 'queryCacheOwnerV1';

/** Native reads MMKV synchronously, so the restore happens before first render. */
export const SUPPORTS_SYNC_RESTORE = true;
/**
 * A blob with no owner sentinel hydrates NOTHING on native. Presence
 * (`persistedQueryCacheExists`) is defined as the sentinel existing, so allowing
 * a sentinel-less blob to hydrate would make hydrated data invisible to the
 * sign-out wipe. Making the hint mandatory keeps presence and hydratability in
 * exact agreement.
 */
export const REQUIRES_OWNER_HINT = true;

export function readPersistedCacheSync(): string | null {
  return storage.getString(CACHE_KEY) ?? null;
}

export function readCacheOwnerSync(): string | null {
  return storage.getString(OWNER_KEY) ?? null;
}

export async function readPersistedCacheAsync(_owner?: UserStorageOwner | null): Promise<string | null> {
  return readPersistedCacheSync();
}

export function writePersistedCache(serialized: string, _owner?: UserStorageOwner | null): void {
  storage.set(CACHE_KEY, serialized);
}

export function writeCacheOwner(userId: string): void {
  storage.set(OWNER_KEY, userId);
}

/**
 * Cheap on purpose: the short owner sentinel, never the blob. This is called on
 * every anonymous transition, and reading up to 512 KB of JSON just to answer a
 * boolean would be wasteful. `getString(...) !== undefined` rather than
 * `contains(...)` because the shared vitest MMKV stub implements only
 * getString/set/remove/clearAll.
 */
export async function persistedQueryCacheExists(_owner?: UserStorageOwner | null): Promise<boolean> {
  return storage.getString(OWNER_KEY) !== undefined;
}

export async function clearPersistedQueryCache(_owner?: UserStorageOwner | null): Promise<void> {
  storage.remove(CACHE_KEY);
  storage.remove(OWNER_KEY);
}
