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

const { _resetBoardRenderSettingsForTests, loadBoardRenderSettings, setBoardRenderModePreference } =
  await import('../../board-render-settings');
const { hasSeenBoardLookStep, markBoardLookStepSeen } = await import('../board-look-step-seen');
const { replayBoardLookStep } = await import('../replay-board-look-step');

beforeEach(() => {
  storage.clear();
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
    await markBoardLookStepSeen();
    expect(await hasSeenBoardLookStep()).toBe(true);

    await replayBoardLookStep(() => {});

    expect(await hasSeenBoardLookStep()).toBe(false);
  });

  it('navigates only after both resets have settled', async () => {
    // Ordering matters for the same reason it does in `replayOnboarding`: a
    // replayed step answered before the clears land would let its own write go
    // first, and the late clear would then wipe it — re-firing on next launch.
    let seenWhenNavigated: boolean | undefined;
    let modeWhenNavigated: string | undefined;
    await setBoardRenderModePreference('classic');
    await markBoardLookStepSeen();

    await replayBoardLookStep(() => {
      seenWhenNavigated = storage.has('boardLookStepSeen');
      modeWhenNavigated = 'navigated';
    });

    expect(modeWhenNavigated).toBe('navigated');
    expect(seenWhenNavigated).toBe(false);
    expect((await loadBoardRenderSettings()).mode).toBe('default');
  });

  it('leaves the hold-colour store alone', async () => {
    // The whole point of this row over "Reset board look": re-testing the step
    // must not cost a colour-blind climber their palette.
    storage.set('holdColorOverrides', JSON.stringify({ colors: { HAND: '#123456' } }));

    await replayBoardLookStep(() => {});

    expect(storage.get('holdColorOverrides')).toContain('#123456');
  });
});

describe('the seen marker shares a lifecycle with the setting it records', () => {
  it('lives in AsyncStorage, not the keychain', async () => {
    // On iOS the keychain survives an uninstall while the app sandbox does not.
    // A marker kept there would outlive the mode it records: reinstalling would
    // reset the choice to `default` (now the Boardsesh drawing) while the
    // surviving marker suppressed the question — silently changing a climber's
    // board with no way to be asked again.
    await markBoardLookStepSeen();

    expect([...storage.keys()]).toContain('boardLookStepSeen');
  });

  it('is wiped together with the render setting when the sandbox goes', async () => {
    await setBoardRenderModePreference('classic');
    await markBoardLookStepSeen();

    // An uninstall takes the whole AsyncStorage sandbox with it.
    storage.clear();
    _resetBoardRenderSettingsForTests();

    expect(await hasSeenBoardLookStep()).toBe(false);
    expect((await loadBoardRenderSettings()).mode).toBe('default');
  });
});
