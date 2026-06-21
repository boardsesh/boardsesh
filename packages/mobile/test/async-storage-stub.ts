// Vitest stub for `@react-native-async-storage/async-storage`.
//
// The real package's ESM entry imports `./createAsyncStorage` without a file
// extension, which fails to resolve under vitest's node ESM environment. Any
// suite that transitively imports a module backed by AsyncStorage (the
// active-board store, the preference store, etc.) would otherwise fail to load
// before a single test runs — even when the suite never touches storage.
//
// This stub is a simple in-memory key-value map. Suites that assert specific
// storage behaviour register their own `vi.mock('@react-native-async-storage/
// async-storage', ...)`, which takes precedence over this alias.
//
// Wired via the `@react-native-async-storage/async-storage` alias in
// packages/mobile/vite.config.ts.

const store = new Map<string, string>();

const AsyncStorage = {
  async getItem(key: string): Promise<string | null> {
    return store.has(key) ? (store.get(key) ?? null) : null;
  },
  async setItem(key: string, value: string): Promise<void> {
    store.set(key, value);
  },
  async removeItem(key: string): Promise<void> {
    store.delete(key);
  },
  async clear(): Promise<void> {
    store.clear();
  },
  async getAllKeys(): Promise<string[]> {
    return [...store.keys()];
  },
  async multiGet(keys: string[]): Promise<[string, string | null][]> {
    return keys.map((key) => [key, store.get(key) ?? null]);
  },
  async multiSet(pairs: [string, string][]): Promise<void> {
    for (const [key, value] of pairs) store.set(key, value);
  },
  async multiRemove(keys: string[]): Promise<void> {
    for (const key of keys) store.delete(key);
  },
};

export default AsyncStorage;
