import { describe, it, expect, vi, beforeEach } from 'vitest';

// The module under test eagerly hydrates an AsyncStorage-backed singleton at
// import; stub the native module so that side effect is a harmless no-op. The
// tests themselves exercise the pure factory with an in-memory fake.
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
  },
}));

import { createAsyncAliasStore } from '../analytics-alias-store';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    getItem: vi.fn(async (key: string) => data.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),
  };
}

const STORAGE_KEY = 'boardsesh:posthog-aliases';

describe('createAsyncAliasStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports a pair as not recorded until recordAlias runs', () => {
    const { store } = createAsyncAliasStore(fakeStorage());

    expect(store.hasRecordedAlias('anon', 'user')).toBe(false);
    store.recordAlias('anon', 'user');
    expect(store.hasRecordedAlias('anon', 'user')).toBe(true);
  });

  it('persists recorded pairs to storage', () => {
    const storage = fakeStorage();
    const { store } = createAsyncAliasStore(storage);

    store.recordAlias('anon', 'user');

    expect(storage.setItem).toHaveBeenCalledWith(STORAGE_KEY, JSON.stringify(['anon->user']));
  });

  it('does not double-record or re-persist a known pair', () => {
    const storage = fakeStorage();
    const { store } = createAsyncAliasStore(storage);

    store.recordAlias('anon', 'user');
    store.recordAlias('anon', 'user');

    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it('hydrates the in-memory mirror from existing storage', async () => {
    const storage = fakeStorage({ [STORAGE_KEY]: JSON.stringify(['anon->user']) });
    const { store, hydrate } = createAsyncAliasStore(storage);

    expect(store.hasRecordedAlias('anon', 'user')).toBe(false);
    await hydrate();
    expect(store.hasRecordedAlias('anon', 'user')).toBe(true);
  });

  it('tolerates a corrupt (non-array) stored value', async () => {
    const storage = fakeStorage({ [STORAGE_KEY]: '{"not":"an array"}' });
    const { store, hydrate } = createAsyncAliasStore(storage);

    await hydrate();
    expect(store.hasRecordedAlias('anon', 'user')).toBe(false);
  });

  it('caps the stored set at 64 pairs, evicting the oldest', () => {
    const storage = fakeStorage();
    const { store } = createAsyncAliasStore(storage);

    for (let index = 0; index < 70; index += 1) {
      store.recordAlias('anon', `user-${index}`);
    }

    // Oldest evicted, newest retained.
    expect(store.hasRecordedAlias('anon', 'user-0')).toBe(false);
    expect(store.hasRecordedAlias('anon', 'user-69')).toBe(true);

    const lastWrite = storage.setItem.mock.calls.at(-1)?.[1] ?? '[]';
    expect(JSON.parse(lastWrite)).toHaveLength(64);
  });
});
