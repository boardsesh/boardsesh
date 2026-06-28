import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('expo-secure-store', () => {
  let storage: Record<string, string> = {};
  let failNext = false;
  return {
    getItemAsync: vi.fn(async (key: string) => {
      if (failNext) {
        failNext = false;
        throw new Error('boom');
      }
      return storage[key] ?? null;
    }),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      if (failNext) {
        failNext = false;
        throw new Error('boom');
      }
      storage[key] = value;
    }),
    __reset: () => {
      storage = {};
    },
    __failNext: () => {
      failNext = true;
    },
    __raw: () => storage,
  };
});

const STORE_KEY = 'boardsesh_last_used_grade';

async function secureStore() {
  return (await import('expo-secure-store')) as unknown as {
    __reset: () => void;
    __failNext: () => void;
    __raw: () => Record<string, string>;
    setItemAsync: (key: string, value: string) => Promise<void>;
  };
}

beforeEach(async () => {
  (await secureStore()).__reset();
});

describe('last-grade-store', () => {
  it('returns undefined when nothing is stored', async () => {
    const { getLastUsedGradeId } = await import('../last-grade-store');
    expect(await getLastUsedGradeId()).toBeUndefined();
  });

  it('round-trips a difficulty id', async () => {
    const { getLastUsedGradeId, setLastUsedGradeId } = await import('../last-grade-store');
    await setLastUsedGradeId(22);
    expect((await secureStore()).__raw()[STORE_KEY]).toBe('22');
    expect(await getLastUsedGradeId()).toBe(22);
  });

  it('returns undefined for a non-numeric stored value', async () => {
    const store = await secureStore();
    await store.setItemAsync(STORE_KEY, 'not-a-number');
    const { getLastUsedGradeId } = await import('../last-grade-store');
    expect(await getLastUsedGradeId()).toBeUndefined();
  });

  it('swallows read errors and returns undefined', async () => {
    const store = await secureStore();
    store.__failNext();
    const { getLastUsedGradeId } = await import('../last-grade-store');
    await expect(getLastUsedGradeId()).resolves.toBeUndefined();
  });

  it('swallows write errors', async () => {
    const store = await secureStore();
    store.__failNext();
    const { setLastUsedGradeId } = await import('../last-grade-store');
    await expect(setLastUsedGradeId(15)).resolves.toBeUndefined();
  });
});
