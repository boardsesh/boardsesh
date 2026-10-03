import { afterEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: async (key: string) => {
      storage.delete(key);
    },
  },
}));

const {
  getSprayWallsUseOwnLook,
  resetSprayWallsUseOwnLookForTests,
  setSprayWallsUseOwnLook,
  subscribeToSprayWallsUseOwnLook,
} = await import('../spray-wall-look-preference');

afterEach(() => {
  storage.clear();
  resetSprayWallsUseOwnLookForTests();
});

describe('spray wall look preference', () => {
  it("is off until the climber turns it on, so walls draw in their creator's look", () => {
    expect(getSprayWallsUseOwnLook()).toBe(false);
  });

  it('loads a stored opt-out on first subscribe and wakes the reader', async () => {
    await setSprayWallsUseOwnLook(true);
    resetSprayWallsUseOwnLookForTests();
    expect(getSprayWallsUseOwnLook()).toBe(false);

    const onChange = vi.fn();
    const unsubscribe = subscribeToSprayWallsUseOwnLook(onChange);
    await vi.waitFor(() => expect(getSprayWallsUseOwnLook()).toBe(true));
    expect(onChange).toHaveBeenCalled();
    unsubscribe();
  });

  it('keeps a choice made while the stored value was still loading', async () => {
    await setSprayWallsUseOwnLook(true);
    resetSprayWallsUseOwnLookForTests();

    const unsubscribe = subscribeToSprayWallsUseOwnLook(() => {});
    await setSprayWallsUseOwnLook(false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getSprayWallsUseOwnLook()).toBe(false);
    unsubscribe();
  });
});
