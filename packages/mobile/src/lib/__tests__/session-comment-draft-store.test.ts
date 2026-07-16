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
      __keys: () => Object.keys(storage),
    },
  };
});

async function getStorageMock() {
  return (await import('@react-native-async-storage/async-storage')).default as unknown as {
    __reset: () => void;
    __keys: () => string[];
  };
}

describe('session-comment-draft-store', () => {
  beforeEach(async () => {
    vi.resetModules();
    (await getStorageMock()).__reset();
  });

  it('round-trips a draft for a session', async () => {
    const { setDraftComment, getDraftComment } = await import('../session-comment-draft-store');
    await setDraftComment('session-1', 'sent my project');
    await expect(getDraftComment('session-1')).resolves.toBe('sent my project');
  });

  it('returns null when no draft is stored', async () => {
    const { getDraftComment } = await import('../session-comment-draft-store');
    await expect(getDraftComment('session-1')).resolves.toBeNull();
  });

  it('misses for a different session (single-slot, one draft at a time)', async () => {
    const { setDraftComment, getDraftComment } = await import('../session-comment-draft-store');
    await setDraftComment('session-1', 'notes for one');
    await expect(getDraftComment('session-2')).resolves.toBeNull();
  });

  it('overwrites the slot when a new sessionId is written', async () => {
    const { setDraftComment, getDraftComment } = await import('../session-comment-draft-store');
    await setDraftComment('session-1', 'first');
    await setDraftComment('session-2', 'second');
    // The old session's draft is gone (single slot); the new one reads back.
    await expect(getDraftComment('session-1')).resolves.toBeNull();
    await expect(getDraftComment('session-2')).resolves.toBe('second');
  });

  it('clears the stored draft', async () => {
    const { setDraftComment, getDraftComment, clearDraftComment } = await import('../session-comment-draft-store');
    await setDraftComment('session-1', 'to be cleared');
    await clearDraftComment('session-1');
    await expect(getDraftComment('session-1')).resolves.toBeNull();
  });
});
