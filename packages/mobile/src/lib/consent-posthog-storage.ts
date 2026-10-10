import type { PostHogCustomStorage } from 'posthog-react-native';

type StorageBackend = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, payload: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

/** One SDK instance, with serialized disk writes so revocation cannot resurrect an old file. */
export function createConsentPosthogStorage(
  backend: StorageBackend,
  initiallyGranted: boolean,
  initialMemory: ReadonlyMap<string, string> = new Map(),
) {
  let persistent = initiallyGranted;
  let generation = 0;
  let writes: Promise<void> = Promise.resolve();
  const memory = new Map(initialMemory);
  const keys = ['.posthog-rn.json', '.posthog-rn-logs.json'];
  const storage: PostHogCustomStorage = {
    getItem: async (key) => {
      if (!persistent) return memory.get(key) ?? null;
      const epoch = generation;
      const payload = await backend.getItem(key);
      return persistent && generation === epoch ? payload : null;
    },
    setItem: (key, payload) => {
      memory.set(key, payload);
      if (!persistent) return Promise.resolve();
      const epoch = generation;
      writes = writes
        .catch(() => {})
        .then(async () => {
          if (persistent && epoch === generation) await backend.setItem(key, payload);
        });
      return writes;
    },
  };
  function suspend(): void {
    if (!persistent) return;
    persistent = false;
    generation++;
  }
  async function setGranted(granted: boolean): Promise<void> {
    if (granted && persistent) return writes;
    persistent = granted;
    generation++;
    if (!granted) {
      memory.clear();
      writes = writes
        .catch(() => {})
        .then(async () => {
          for (const key of keys) await backend.removeItem(key);
        });
    } else {
      const epoch = generation;
      writes = writes
        .catch(() => {})
        .then(async () => {
          if (!persistent || generation !== epoch) return;
          for (const [key, payload] of memory) await backend.setItem(key, payload);
        });
    }
    await writes;
  }
  return { storage, setGranted, suspend };
}
