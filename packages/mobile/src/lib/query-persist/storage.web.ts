import AsyncStorage from '@react-native-async-storage/async-storage';
import { userScopedStorageKey } from '../user-storage-owner.web';
import type { UserStorageOwner } from '../user-storage-owner';
import { utf8ByteLength } from './envelope';

// Web keys are LOGIN-scoped via `userScopedStorageKey`, which means three things
// on purpose:
//
// 1. They carry the exact `:user:<id>:auth-session:<sid>` suffix and live in the
//    plain AsyncStorage keyspace, so `sweepOrphanedUserStorage` →
//    `removePreferencesMatching` can reclaim them. That sweep is the only thing
//    that ever cleans up a blob orphaned by cookie expiry — otherwise up to
//    512 KB of profile data per abandoned login sits there forever.
// 2. A null key (no resolvable owner) makes every read/write/delete a silent
//    no-op, exactly like `session-store.web.ts`. A cross-login read is not
//    merely checked, it is unexpressible.
// 3. The blob is written with `AsyncStorage.setItem` DIRECTLY rather than
//    through `preference-store`. `setPreference` would `JSON.stringify` an
//    already-serialized JSON string, adding escaping overhead and forcing a
//    `JSON.parse` on read just to recover the string before parsing it again —
//    which both makes the byte budget disagree with what is actually stored and
//    costs real milliseconds on a cold start. `removePreferencesMatching`
//    operates on raw keys, so bypassing the wrapper costs nothing in sweep
//    coverage.
const BLOB_BASE = 'boardsesh_query_cache_v1';
const META_BASE = 'boardsesh_query_cache_meta_v1';

/** No MMKV mirror on web: its web build is `localStorage` on the Next app's origin. */
export const SUPPORTS_SYNC_RESTORE = false;
/** The login-scoped key already proves ownership; the blob's stamp is the belt to that braces. */
export const REQUIRES_OWNER_HINT = false;

// No `userId` field: on web the owning account is already in the key itself.
type CacheMeta = { savedAt: number; bytes: number };

export function readPersistedCacheSync(): string | null {
  return null;
}

export function readCacheOwnerSync(): string | null {
  return null;
}

export async function readPersistedCacheAsync(owner?: UserStorageOwner | null): Promise<string | null> {
  const storageKey = userScopedStorageKey(BLOB_BASE, owner);
  if (!storageKey) return null;
  try {
    return await AsyncStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

export async function writePersistedCache(serialized: string, owner?: UserStorageOwner | null): Promise<void> {
  const storageKey = userScopedStorageKey(BLOB_BASE, owner);
  const metaKey = userScopedStorageKey(META_BASE, owner);
  if (!storageKey || !metaKey) return;
  await AsyncStorage.setItem(storageKey, serialized);
  // ~80 bytes, so `persistedQueryCacheExists` is a small read rather than a
  // 512 KB one.
  const meta: CacheMeta = { savedAt: Date.now(), bytes: utf8ByteLength(serialized) };
  await AsyncStorage.setItem(metaKey, JSON.stringify(meta));
}

export function writeCacheOwner(_userId: string): void {
  // No-op: the web key itself is login-scoped, so ownership is in the key.
}

export async function persistedQueryCacheExists(owner?: UserStorageOwner | null): Promise<boolean> {
  const metaKey = userScopedStorageKey(META_BASE, owner);
  if (!metaKey) return false;
  try {
    return (await AsyncStorage.getItem(metaKey)) !== null;
  } catch {
    return false;
  }
}

export async function clearPersistedQueryCache(owner?: UserStorageOwner | null): Promise<void> {
  const storageKey = userScopedStorageKey(BLOB_BASE, owner);
  const metaKey = userScopedStorageKey(META_BASE, owner);
  const keys = [storageKey, metaKey].filter((key): key is string => key !== null);
  if (keys.length === 0) return;
  await Promise.all(keys.map((key) => AsyncStorage.removeItem(key)));
}

/** Exported for the sweep test: the exact bases `sweepOrphanedUserStorage` must match. */
export const QUERY_CACHE_STORAGE_BASES = [BLOB_BASE, META_BASE] as const;
