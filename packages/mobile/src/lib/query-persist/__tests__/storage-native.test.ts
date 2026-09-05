import { describe, it, expect, beforeEach, vi } from 'vitest';

// The shared vitest MMKV stub (test/react-native-mmkv-stub.ts) ignores `id` and
// shares ONE process-wide Map across every "instance", so an isolation
// assertion against it would false-pass. This suite registers its own mock with
// a map per id — the same pattern settings/__tests__/offline-boards.test.ts uses.
const instances = vi.hoisted(() => new Map<string, Map<string, string>>());
vi.mock('react-native-mmkv', () => ({
  createMMKV: ({ id }: { id: string }) => {
    const store = instances.get(id) ?? new Map<string, string>();
    instances.set(id, store);
    return {
      getString: (key: string) => store.get(key),
      set: (key: string, value: string) => {
        store.set(key, value);
      },
      remove: (key: string) => {
        store.delete(key);
      },
      clearAll: () => {
        store.clear();
      },
    };
  },
}));

import {
  REQUIRES_OWNER_HINT,
  SUPPORTS_SYNC_RESTORE,
  clearPersistedQueryCache,
  persistedQueryCacheExists,
  readCacheOwnerSync,
  readPersistedCacheAsync,
  readPersistedCacheSync,
  writeCacheOwner,
  writePersistedCache,
} from '../storage';
import { setSetting } from '../../../settings';

const QUERY_CACHE_ID = 'boardsesh-query-cache';
const SETTINGS_ID = 'boardsesh-settings';

beforeEach(() => {
  for (const store of instances.values()) store.clear();
});

// T-16b
describe('native query-cache storage', () => {
  it('declares the native restore contract', () => {
    expect(SUPPORTS_SYNC_RESTORE).toBe(true);
    // Without a mandatory owner sentinel a blob could hydrate while
    // `persistedQueryCacheExists` answered "no" about it.
    expect(REQUIRES_OWNER_HINT).toBe(true);
  });

  it('keeps the blob out of the settings instance', async () => {
    writePersistedCache('{"version":1}');
    writeCacheOwner('user-1');
    setSetting('syncEnabledBoards', []);

    expect([...(instances.get(QUERY_CACHE_ID)?.values() ?? [])]).toContain('{"version":1}');
    expect([...(instances.get(SETTINGS_ID)?.values() ?? [])]).not.toContain('{"version":1}');
    // ...and the settings instance is where the setting landed, so the two are
    // genuinely separate files rather than one shared map.
    expect(instances.get(SETTINGS_ID)?.size).toBeGreaterThan(0);
  });

  it('reads back synchronously and asynchronously', async () => {
    writePersistedCache('{"version":1}');
    writeCacheOwner('user-1');

    expect(readPersistedCacheSync()).toBe('{"version":1}');
    expect(readCacheOwnerSync()).toBe('user-1');
    expect(await readPersistedCacheAsync()).toBe('{"version":1}');
  });

  it('answers presence from the short owner sentinel, not the blob', async () => {
    expect(await persistedQueryCacheExists()).toBe(false);
    // A blob with no sentinel is deliberately NOT "present": presence and
    // hydratability have to agree, and a sentinel-less blob hydrates nothing.
    writePersistedCache('{"version":1}');
    expect(await persistedQueryCacheExists()).toBe(false);
    writeCacheOwner('user-1');
    expect(await persistedQueryCacheExists()).toBe(true);
  });

  it('clears both the blob and the owner key', async () => {
    writePersistedCache('{"version":1}');
    writeCacheOwner('user-1');

    await clearPersistedQueryCache();

    expect(readPersistedCacheSync()).toBeNull();
    expect(readCacheOwnerSync()).toBeNull();
    expect(await persistedQueryCacheExists()).toBe(false);
    expect(instances.get(QUERY_CACHE_ID)?.size).toBe(0);
  });
});
