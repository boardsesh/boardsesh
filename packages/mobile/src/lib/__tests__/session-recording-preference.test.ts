import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

const LEGACY_DEFAULT_ON_FLAG = 'EXPO_PUBLIC_SESSION_RECORDING_DEFAULT_ON';

describe('session-recording-preference', () => {
  const originalFlag = process.env[LEGACY_DEFAULT_ON_FLAG];

  beforeEach(async () => {
    vi.resetModules();
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      __reset: () => void;
    };
    asyncStorage.__reset();
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env[LEGACY_DEFAULT_ON_FLAG];
    else process.env[LEGACY_DEFAULT_ON_FLAG] = originalFlag;
  });

  it('defaults OFF when nothing is stored', async () => {
    delete process.env[LEGACY_DEFAULT_ON_FLAG];
    const { loadSessionRecordingEnabled } = await import('../session-recording-preference');
    await expect(loadSessionRecordingEnabled()).resolves.toBe(false);
  });

  it('ignores the legacy default-on build flag when nothing is stored', async () => {
    process.env[LEGACY_DEFAULT_ON_FLAG] = 'true';
    const { loadSessionRecordingEnabled } = await import('../session-recording-preference');
    await expect(loadSessionRecordingEnabled()).resolves.toBe(false);
  });

  it('honours an explicit OFF choice', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      __setRaw: (key: string, value: string) => void;
    };
    asyncStorage.__setRaw('sessionRecordingEnabled', JSON.stringify(false));

    const { loadSessionRecordingEnabled } = await import('../session-recording-preference');
    await expect(loadSessionRecordingEnabled()).resolves.toBe(false);
  });

  it('honours an explicit ON choice', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      __setRaw: (key: string, value: string) => void;
    };
    asyncStorage.__setRaw('sessionRecordingEnabled', JSON.stringify(true));

    const { loadSessionRecordingEnabled } = await import('../session-recording-preference');
    await expect(loadSessionRecordingEnabled()).resolves.toBe(true);
  });

  it('persists the user opt-in', async () => {
    const { loadSessionRecordingEnabled, setSessionRecordingEnabledPreference } =
      await import('../session-recording-preference');
    await setSessionRecordingEnabledPreference(true);
    await expect(loadSessionRecordingEnabled()).resolves.toBe(true);
  });
});
