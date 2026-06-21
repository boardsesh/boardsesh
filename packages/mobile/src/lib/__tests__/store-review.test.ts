import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeReview = vi.hoisted(() => ({
  hasAction: vi.fn(),
  requestReview: vi.fn(),
}));

const asyncStorage = vi.hoisted(() => {
  let storage: Record<string, string> = {};
  return {
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
  };
});

vi.mock('expo-store-review', () => storeReview);
vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }));

const DAY_MS = 24 * 60 * 60 * 1000;

async function loadStoreReviewModule() {
  return import('../store-review');
}

describe('session store review prompt', () => {
  beforeEach(() => {
    vi.resetModules();
    asyncStorage.__reset();
    storeReview.hasAction.mockReset();
    storeReview.requestReview.mockReset();
    storeReview.hasAction.mockResolvedValue(true);
    storeReview.requestReview.mockResolvedValue(undefined);
  });

  it('requests the native store review flow for a fresh eligible session', async () => {
    const { maybeRequestSessionStoreReview } = await loadStoreReviewModule();

    await expect(maybeRequestSessionStoreReview({ sessionId: 'session-1', totalSends: 3 }, 1000)).resolves.toBe(true);

    expect(storeReview.hasAction).toHaveBeenCalledOnce();
    expect(storeReview.requestReview).toHaveBeenCalledOnce();
  });

  it('does not request review for sessions with 2 or fewer ascents', async () => {
    const { maybeRequestSessionStoreReview } = await loadStoreReviewModule();

    await expect(maybeRequestSessionStoreReview({ sessionId: 'session-1', totalSends: 2 }, 1000)).resolves.toBe(false);

    expect(storeReview.hasAction).not.toHaveBeenCalled();
    expect(storeReview.requestReview).not.toHaveBeenCalled();
  });

  it('skips when the native store review action is unavailable', async () => {
    const { maybeRequestSessionStoreReview } = await loadStoreReviewModule();
    storeReview.hasAction.mockResolvedValueOnce(false);

    await expect(maybeRequestSessionStoreReview({ sessionId: 'session-1', totalSends: 3 }, 1000)).resolves.toBe(false);

    expect(storeReview.requestReview).not.toHaveBeenCalled();
  });

  it('does not request review twice for the same session', async () => {
    const { maybeRequestSessionStoreReview, SESSION_STORE_REVIEW_COOLDOWN_MS } = await loadStoreReviewModule();

    await maybeRequestSessionStoreReview({ sessionId: 'session-1', totalSends: 3 }, 1000);
    storeReview.requestReview.mockClear();

    await expect(
      maybeRequestSessionStoreReview(
        { sessionId: 'session-1', totalSends: 3 },
        1000 + SESSION_STORE_REVIEW_COOLDOWN_MS,
      ),
    ).resolves.toBe(false);

    expect(storeReview.requestReview).not.toHaveBeenCalled();
  });

  it('enforces the 90-day cooldown across different sessions', async () => {
    const { maybeRequestSessionStoreReview } = await loadStoreReviewModule();

    await maybeRequestSessionStoreReview({ sessionId: 'session-1', totalSends: 3 }, 1000);
    storeReview.requestReview.mockClear();

    await expect(
      maybeRequestSessionStoreReview({ sessionId: 'session-2', totalSends: 4 }, 1000 + 89 * DAY_MS),
    ).resolves.toBe(false);
    expect(storeReview.requestReview).not.toHaveBeenCalled();

    await expect(
      maybeRequestSessionStoreReview({ sessionId: 'session-2', totalSends: 4 }, 1000 + 90 * DAY_MS),
    ).resolves.toBe(true);
    expect(storeReview.requestReview).toHaveBeenCalledOnce();
  });

  it('records the attempt before calling the OS review API', async () => {
    const { maybeRequestSessionStoreReview, SESSION_STORE_REVIEW_COOLDOWN_MS } = await loadStoreReviewModule();
    storeReview.requestReview.mockRejectedValueOnce(new Error('store failed'));

    await expect(maybeRequestSessionStoreReview({ sessionId: 'session-1', totalSends: 3 }, 1000)).resolves.toBe(false);
    storeReview.requestReview.mockClear();

    await expect(
      maybeRequestSessionStoreReview(
        { sessionId: 'session-2', totalSends: 3 },
        1000 + SESSION_STORE_REVIEW_COOLDOWN_MS - 1,
      ),
    ).resolves.toBe(false);
    expect(storeReview.requestReview).not.toHaveBeenCalled();
  });

  it('does not request review when the cooldown state cannot be saved', async () => {
    const { maybeRequestSessionStoreReview } = await loadStoreReviewModule();
    asyncStorage.setItem.mockRejectedValueOnce(new Error('storage failed'));

    await expect(maybeRequestSessionStoreReview({ sessionId: 'session-1', totalSends: 3 }, 1000)).resolves.toBe(false);

    expect(storeReview.requestReview).not.toHaveBeenCalled();
  });
});
