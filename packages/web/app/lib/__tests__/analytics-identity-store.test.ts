import { describe, expect, it, vi } from 'vite-plus/test';
import {
  createAnalyticsIdentityStore,
  type AnalyticsIdentityRecord,
  type AnalyticsIdentityStorage,
} from '../analytics-identity-store';

function makeMemoryStorage(seed?: AnalyticsIdentityRecord): {
  storage: AnalyticsIdentityStorage;
  written: AnalyticsIdentityRecord[];
} {
  let stored: AnalyticsIdentityRecord | null = seed ?? null;
  const written: AnalyticsIdentityRecord[] = [];
  return {
    written,
    storage: {
      read: async () => stored,
      write: async (record) => {
        stored = record;
        written.push(record);
      },
    },
  };
}

describe('createAnalyticsIdentityStore', () => {
  it('reads nothing before hydration and starts empty when storage is empty', async () => {
    const { storage } = makeMemoryStorage();
    const store = createAnalyticsIdentityStore(storage);

    expect(store.getIdentifiedUserId()).toBe(null);
    await store.hydrate();
    expect(store.getIdentifiedUserId()).toBe(null);
    expect(store.aliasStore.hasRecordedAlias('anon-1', 'user-1')).toBe(false);
  });

  it('restores the identified user and alias pairs from storage', async () => {
    const { storage } = makeMemoryStorage({ identifiedUserId: 'user-1', aliasPairs: ['anon-1->user-1'] });
    const store = createAnalyticsIdentityStore(storage);
    await store.hydrate();

    expect(store.getIdentifiedUserId()).toBe('user-1');
    expect(store.aliasStore.hasRecordedAlias('anon-1', 'user-1')).toBe(true);
    expect(store.aliasStore.hasRecordedAlias('anon-1', 'user-2')).toBe(false);
  });

  it('hydrates once even when called repeatedly', async () => {
    const { storage } = makeMemoryStorage({ identifiedUserId: 'user-1', aliasPairs: [] });
    const readSpy = vi.spyOn(storage, 'read');
    const store = createAnalyticsIdentityStore(storage);

    await Promise.all([store.hydrate(), store.hydrate()]);
    await store.hydrate();

    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it('survives corrupt or blocked storage instead of throwing', async () => {
    const store = createAnalyticsIdentityStore({
      read: async () => 'not a record',
      write: async () => {
        throw new Error('blocked');
      },
    });

    await store.hydrate();
    expect(store.getIdentifiedUserId()).toBe(null);

    // The failing write must not surface as an unhandled rejection.
    store.setIdentifiedUserId('user-1');
    expect(store.getIdentifiedUserId()).toBe('user-1');
    await Promise.resolve();
  });

  it('persists the identified user and skips no-op writes', async () => {
    const { storage, written } = makeMemoryStorage();
    const store = createAnalyticsIdentityStore(storage);
    await store.hydrate();

    store.setIdentifiedUserId('user-1');
    store.setIdentifiedUserId('user-1');
    await Promise.resolve();

    expect(written).toHaveLength(1);
    expect(written[0].identifiedUserId).toBe('user-1');

    store.setIdentifiedUserId(null);
    await Promise.resolve();
    expect(written).toHaveLength(2);
    expect(written[1].identifiedUserId).toBe(null);
  });

  it('records alias pairs synchronously and persists them', async () => {
    const { storage, written } = makeMemoryStorage();
    const store = createAnalyticsIdentityStore(storage);
    await store.hydrate();

    store.aliasStore.recordAlias('anon-1', 'user-1');
    // Synchronous read-back is the contract reconcileAnalyticsIdentity relies on.
    expect(store.aliasStore.hasRecordedAlias('anon-1', 'user-1')).toBe(true);

    store.aliasStore.recordAlias('anon-1', 'user-1');
    await Promise.resolve();

    expect(written).toHaveLength(1);
    expect(written[0].aliasPairs).toEqual(['anon-1->user-1']);
  });

  it('bounds the alias set so a shared browser cannot grow it forever', async () => {
    const { storage } = makeMemoryStorage();
    const store = createAnalyticsIdentityStore(storage);
    await store.hydrate();

    for (let index = 0; index < 70; index += 1) {
      store.aliasStore.recordAlias(`anon-${index}`, `user-${index}`);
    }

    expect(store.aliasStore.hasRecordedAlias('anon-0', 'user-0')).toBe(false);
    expect(store.aliasStore.hasRecordedAlias('anon-69', 'user-69')).toBe(true);
  });
});
