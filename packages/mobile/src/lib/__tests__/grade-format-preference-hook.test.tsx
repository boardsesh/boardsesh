// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Controllable AsyncStorage so each test starts from a clean store and can count
// reads. Mirrors the pure-function test's mock shape.
vi.mock('@react-native-async-storage/async-storage', () => {
  let storage: Record<string, string> = {};
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage[key] ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage[key] = value;
      }),
      removeItem: vi.fn(async (key: string) => {
        delete storage[key];
      }),
      __reset: () => {
        storage = {};
      },
      __setRaw: (key: string, value: string) => {
        storage[key] = value;
      },
    },
  };
});

type MockAsyncStorage = {
  getItem: ReturnType<typeof vi.fn>;
  __reset: () => void;
  __setRaw: (key: string, value: string) => void;
};

async function getAsyncStorage(): Promise<MockAsyncStorage> {
  return (await import('@react-native-async-storage/async-storage')).default as unknown as MockAsyncStorage;
}

describe('useGradeDisplayFormatPreference', () => {
  beforeEach(async () => {
    // Fresh module ⇒ module-level store (current/hasLoaded/loadStarted/listeners)
    // resets between tests.
    vi.resetModules();
    (await getAsyncStorage()).__reset();
  });

  it('returns the default before the load resolves, then the stored value', async () => {
    (await getAsyncStorage()).__setRaw('gradeDisplayFormat', JSON.stringify('both'));
    const { useGradeDisplayFormatPreference } = await import('../grade-format-preference');

    const { result } = renderHook(() => useGradeDisplayFormatPreference());

    // Synchronous first render: default, not yet loaded.
    expect(result.current.gradeFormat).toBe('v-grade');
    expect(result.current.loaded).toBe(false);

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.gradeFormat).toBe('both');
  });

  it('triggers the AsyncStorage load exactly once across many mounted consumers', async () => {
    const asyncStorage = await getAsyncStorage();
    const { useGradeDisplayFormatPreference } = await import('../grade-format-preference');
    // Count only the reads this test triggers — the shared vi.fn's call history
    // is not cleared by the storage `__reset`, so prior tests' loads would
    // otherwise leak into the count. The module is fresh (resetModules), so its
    // load singleton hasn't fired yet.
    asyncStorage.getItem.mockClear();

    renderHook(() => useGradeDisplayFormatPreference());
    renderHook(() => useGradeDisplayFormatPreference());
    renderHook(() => useGradeDisplayFormatPreference());

    await waitFor(() => expect(asyncStorage.getItem).toHaveBeenCalled());
    // The promise singleton ⇒ three mounted consumers share ONE load.
    expect(asyncStorage.getItem).toHaveBeenCalledTimes(1);
  });

  it('fans a setGradeFormat change out to every mounted consumer', async () => {
    const { useGradeDisplayFormatPreference } = await import('../grade-format-preference');

    const first = renderHook(() => useGradeDisplayFormatPreference());
    const second = renderHook(() => useGradeDisplayFormatPreference());

    await act(async () => {
      first.result.current.setGradeFormat('font');
    });

    expect(first.result.current.gradeFormat).toBe('font');
    expect(second.result.current.gradeFormat).toBe('font');
  });
});
