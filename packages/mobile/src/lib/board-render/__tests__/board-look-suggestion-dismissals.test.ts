import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  values: new Map<string, string>(),
  failReads: false,
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => {
      if (store.failReads) throw new Error('storage unavailable');
      return store.values.get(key) ?? null;
    },
    setItem: async (key: string, value: string) => {
      store.values.set(key, value);
    },
    removeItem: async (key: string) => {
      store.values.delete(key);
    },
  },
}));

const { clearBoardLookSuggestionDismissals, dismissBoardLookSuggestion, loadBoardLookSuggestionDismissals } =
  await import('../board-look-suggestion-dismissals');

beforeEach(() => {
  store.values.clear();
  store.failReads = false;
  delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
});

afterEach(() => {
  store.values.clear();
  store.failReads = false;
  delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
});

describe('board-look suggestion dismissals', () => {
  it('starts with nothing dismissed', async () => {
    expect(await loadBoardLookSuggestionDismissals()).toEqual({ increaseContrast: false, grayscale: false });
  });

  it('round-trips a dismissal without touching the other one', async () => {
    await dismissBoardLookSuggestion('grayscale');

    expect(await loadBoardLookSuggestionDismissals()).toEqual({ increaseContrast: false, grayscale: true });

    await dismissBoardLookSuggestion('increaseContrast');

    expect(await loadBoardLookSuggestionDismissals()).toEqual({ increaseContrast: true, grayscale: true });
  });

  it('clears back to nothing dismissed', async () => {
    await dismissBoardLookSuggestion('grayscale');

    await clearBoardLookSuggestionDismissals();

    expect(await loadBoardLookSuggestionDismissals()).toEqual({ increaseContrast: false, grayscale: false });
  });

  it('reports DISMISSED when the store cannot be read', async () => {
    // Fail towards silence, exactly like `hasSeenBoardLookStep`: a flaky store
    // must never turn a once-dismissed suggestion into one that returns on
    // every cold start.
    store.failReads = true;

    expect(await loadBoardLookSuggestionDismissals()).toEqual({ increaseContrast: true, grayscale: true });
  });

  it('reports DISMISSED in screenshot mode', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';

    expect(await loadBoardLookSuggestionDismissals()).toEqual({ increaseContrast: true, grayscale: true });
  });

  it('ignores a stored payload that is not the shape it wrote', async () => {
    store.values.set('boardLookSuggestionDismissals', JSON.stringify({ grayscale: 'yes', bogus: true }));

    expect(await loadBoardLookSuggestionDismissals()).toEqual({ increaseContrast: false, grayscale: false });
  });

  it('lives in AsyncStorage, next to the setting it refers to', async () => {
    // On iOS the keychain survives an uninstall while the app sandbox does not.
    // A dismissal in SecureStore would outlive the look it was about: reinstall,
    // get `boardRenderSettings` back to `default`, and carry a permanent "never
    // suggest Max contrast" flag for a look you no longer have.
    await dismissBoardLookSuggestion('increaseContrast');

    expect([...store.values.keys()]).toEqual(['boardLookSuggestionDismissals']);
  });
});
