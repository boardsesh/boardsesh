import { beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  getPreference: vi.fn(),
  setPreference: vi.fn(async () => undefined),
}));

vi.mock('../../preference-store', () => ({
  getPreference: spies.getPreference,
  setPreference: spies.setPreference,
}));

import { emptyNudgeState, withNudgeShown } from '../nudge-policy';
import {
  OFFLINE_NUDGE_STATE_KEY,
  __resetNudgeStateCacheForTests,
  loadNudgeState,
  parseNudgeState,
  saveNudgeState,
} from '../nudge-storage';

beforeEach(() => {
  vi.clearAllMocks();
  __resetNudgeStateCacheForTests();
});

describe('nudge-storage', () => {
  it('returns defaults when nothing is stored', async () => {
    spies.getPreference.mockResolvedValue(null);
    await expect(loadNudgeState()).resolves.toEqual(emptyNudgeState());
  });

  it('round-trips a written state', async () => {
    const state = withNudgeShown(emptyNudgeState(), 'post_session', 1_700_000_000_000);
    await saveNudgeState(state);
    expect(spies.setPreference).toHaveBeenCalledWith(OFFLINE_NUDGE_STATE_KEY, state);
    await expect(loadNudgeState()).resolves.toEqual(state);
  });

  // A rejection is not "no value stored" — iOS can deny the backing-file read
  // before first unlock. Suppress this run, cache nothing, retry next time.
  it('suppresses every surface when the read rejects, and retries afterwards', async () => {
    spies.getPreference.mockRejectedValueOnce(new Error('locked'));
    const suppressed = await loadNudgeState();
    for (const surface of Object.values(suppressed.surfaces)) {
      expect(surface.dismissedForever).toBe(true);
    }

    spies.getPreference.mockResolvedValueOnce(null);
    await expect(loadNudgeState()).resolves.toEqual(emptyNudgeState());
  });

  it('degrades a corrupt or legacy payload to defaults', () => {
    expect(parseNudgeState('not-an-object')).toEqual(emptyNudgeState());
    expect(parseNudgeState({ surfaces: 42, lastPromptAtMs: 'soon' })).toEqual(emptyNudgeState());

    const partial = parseNudgeState({
      surfaces: { post_session: { shownCount: 2, dismissedForever: 'yes' }, ancient_surface: {} },
      lastAcceptedAtMs: 5,
    });
    expect(partial.surfaces.post_session).toEqual({ lastShownAtMs: null, shownCount: 2, dismissedForever: false });
    expect(partial.lastAcceptedAtMs).toBe(5);
    expect(partial.surfaces.board_card).toEqual({ lastShownAtMs: null, shownCount: 0, dismissedForever: false });
  });
});
