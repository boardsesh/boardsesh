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

const secureStore = vi.hoisted(() => ({ remove: vi.fn(async () => {}) }));
vi.mock('../../preferences/secure-store-adapter', () => ({ secureStorePreferences: secureStore }));

const { BOARD_LOOK_STEP_SEEN_KEY } = await import('@boardsesh/key-value-storage');
const { _resetBoardRenderSettingsForTests, loadBoardRenderSettings, setBoardRenderModePreference } =
  await import('../../board-render-settings');
const { replayBoardLookStep } = await import('../replay-board-look-step');

beforeEach(() => {
  storage.clear();
  secureStore.remove.mockClear();
  _resetBoardRenderSettingsForTests();
});

afterEach(() => {
  storage.clear();
  _resetBoardRenderSettingsForTests();
});

describe('replayBoardLookStep', () => {
  it('puts the mode back to `default`, which is what the gate actually checks', async () => {
    // The regression this guards: clearing the seen flag alone leaves the step
    // just as invisible, because the gate skips anyone who has already chosen a
    // mode — and choosing one is exactly what someone replaying has done.
    await setBoardRenderModePreference('boardsesh');

    await replayBoardLookStep(() => {});

    expect((await loadBoardRenderSettings()).mode).toBe('default');
  });

  it('clears the seen flag', async () => {
    await replayBoardLookStep(() => {});
    expect(secureStore.remove).toHaveBeenCalledWith(BOARD_LOOK_STEP_SEEN_KEY);
  });

  it('navigates only after both resets have settled', async () => {
    // Ordering matters for the same reason it does in `replayOnboarding`: a
    // replayed step answered before the clears land would let its own write go
    // first, and the late clear would then wipe it — re-firing on next launch.
    let modeWhenNavigated: string | undefined;
    await setBoardRenderModePreference('classic');

    await replayBoardLookStep(() => {
      modeWhenNavigated = 'navigated';
      expect(secureStore.remove).toHaveBeenCalled();
    });

    expect(modeWhenNavigated).toBe('navigated');
    expect((await loadBoardRenderSettings()).mode).toBe('default');
  });

  it('leaves the hold-colour store alone', async () => {
    // The whole point of this row over "Reset board look": re-testing the step
    // must not cost a colour-blind climber their palette.
    await replayBoardLookStep(() => {});
    expect(secureStore.remove).toHaveBeenCalledTimes(1);
    expect(secureStore.remove).not.toHaveBeenCalledWith('holdColorOverrides');
  });
});
