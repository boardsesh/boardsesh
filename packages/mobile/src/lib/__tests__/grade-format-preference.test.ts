import { describe, it, expect, vi, beforeEach } from 'vitest';

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

describe('grade-format-preference', () => {
  beforeEach(async () => {
    vi.resetModules();
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      __reset: () => void;
    };
    asyncStorage.__reset();
  });

  it('defaults to V-grade when no preference is stored', async () => {
    const { loadGradeDisplayFormat } = await import('../grade-format-preference');
    await expect(loadGradeDisplayFormat()).resolves.toBe('v-grade');
  });

  it('loads a stored combined grade format', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      __setRaw: (key: string, value: string) => void;
    };
    asyncStorage.__setRaw('gradeDisplayFormat', JSON.stringify('both'));

    const { loadGradeDisplayFormat } = await import('../grade-format-preference');
    await expect(loadGradeDisplayFormat()).resolves.toBe('both');
  });

  it('falls back to V-grade for invalid stored values', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      __setRaw: (key: string, value: string) => void;
    };
    asyncStorage.__setRaw('gradeDisplayFormat', JSON.stringify('invalid'));

    const { loadGradeDisplayFormat } = await import('../grade-format-preference');
    await expect(loadGradeDisplayFormat()).resolves.toBe('v-grade');
  });

  it('persists the selected grade format', async () => {
    const { loadGradeDisplayFormat, setGradeDisplayFormatPreference } = await import('../grade-format-preference');
    await setGradeDisplayFormatPreference('font');
    await expect(loadGradeDisplayFormat()).resolves.toBe('font');
  });
});
