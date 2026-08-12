// Vitest stub for `react-native-mmkv`.
//
// The real package's react-native Flow entry throws a `SyntaxError: Unexpected
// token 'typeof'` under vitest's node env. The settings store binds an MMKV
// instance at module load, so ANY suite that transitively reaches
// `src/settings` — which is most of them, now that the offline adapter reads
// persisted download-trigger attribution — would fail to load before a single
// test ran.
//
// In-memory and per-process, so a suite that writes settings sees its own
// writes. Suites that need to reset between tests (or assert on the raw stored
// bytes) register their own `vi.mock('react-native-mmkv', ...)`, which takes
// precedence over this alias. Wired via the `react-native-mmkv` alias in
// packages/mobile/vite.config.ts.

const store = new Map<string, string>();

function createMMKVInstance() {
  return {
    getString(key: string): string | undefined {
      return store.get(key);
    },
    set(key: string, value: string): void {
      store.set(key, value);
    },
    remove(key: string): void {
      store.delete(key);
    },
    clearAll(): void {
      store.clear();
    },
  };
}

export function createMMKV(): ReturnType<typeof createMMKVInstance> {
  return createMMKVInstance();
}
