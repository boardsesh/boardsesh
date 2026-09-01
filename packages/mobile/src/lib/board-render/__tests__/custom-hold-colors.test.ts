import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const { clearCustomHoldColors, loadCustomHoldColors, rememberCustomHoldColors } = await import('../custom-hold-colors');

beforeEach(() => storage.clear());
afterEach(() => storage.clear());

describe('custom hold colours', () => {
  it('is null until the climber has picked one by hand', async () => {
    expect(await loadCustomHoldColors()).toBeNull();
  });

  it('survives a palette being applied over the live colours', async () => {
    // The whole point: applying a palette overwrites all four role colours, so
    // without a copy kept aside, trying "Deuteranopia" to compare would destroy
    // a hand-picked set with no undo.
    await rememberCustomHoldColors({ STARTING: '#00ff00', HAND: '#ff00ff' });

    expect(await loadCustomHoldColors()).toEqual({ STARTING: '#00ff00', HAND: '#ff00ff' });
  });

  it('sanitises what it hands back', async () => {
    // A map written by a newer build — or hand-edited — can carry anything.
    storage.set(
      'holdColorCustomColors',
      JSON.stringify({ STARTING: '#ABCDEF', HAND: 'not-a-colour', SOMETHING_ELSE: '#000000' }),
    );

    expect(await loadCustomHoldColors()).toEqual({ STARTING: '#abcdef' });
  });

  it('is forgotten by a reset', async () => {
    await rememberCustomHoldColors({ FOOT: '#123456' });

    await clearCustomHoldColors();

    expect(await loadCustomHoldColors()).toBeNull();
  });
});
