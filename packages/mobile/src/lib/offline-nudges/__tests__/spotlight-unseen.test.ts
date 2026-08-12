import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ enabledBoards: [] as string[], autoOfflineBoards: false }));
const spies = vi.hoisted(() => ({ loadNudgeState: vi.fn() }));

vi.mock('../../../settings', () => ({
  getSetting: (key: string) => (key === 'syncEnabledBoards' ? state.enabledBoards : state.autoOfflineBoards),
}));
vi.mock('../nudge-storage', () => ({ loadNudgeState: spies.loadNudgeState }));

import { emptyNudgeState, withNudgeDismissed, withNudgeShown } from '../nudge-policy';
import { hasUnseenOfflineSpotlight } from '../spotlight-unseen';

const originalScreenshotMode = process.env.EXPO_PUBLIC_SCREENSHOT_MODE;

beforeEach(() => {
  vi.clearAllMocks();
  state.enabledBoards = [];
  state.autoOfflineBoards = false;
  spies.loadNudgeState.mockResolvedValue(emptyNudgeState());
});
afterEach(() => {
  if (originalScreenshotMode === undefined) delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
  else process.env.EXPO_PUBLIC_SCREENSHOT_MODE = originalScreenshotMode;
});

describe('hasUnseenOfflineSpotlight', () => {
  // Without this the spotlight is unreachable: it lives inside What's New, and
  // someone with no unseen changelog entries has no reason to open that screen.
  it('earns the pill for a user with nothing downloaded', async () => {
    await expect(hasUnseenOfflineSpotlight()).resolves.toBe(true);
  });

  it('stays quiet once the user already has a board offline', async () => {
    state.enabledBoards = ['kilter:1:10'];
    await expect(hasUnseenOfflineSpotlight()).resolves.toBe(false);
  });

  it('stays quiet for someone auto-downloading every board', async () => {
    state.autoOfflineBoards = true;
    await expect(hasUnseenOfflineSpotlight()).resolves.toBe(false);
  });

  it('stays quiet after the spotlight has been seen or dismissed', async () => {
    spies.loadNudgeState.mockResolvedValue(withNudgeShown(emptyNudgeState(), 'whats_new', 1));
    await expect(hasUnseenOfflineSpotlight()).resolves.toBe(false);

    spies.loadNudgeState.mockResolvedValue(withNudgeDismissed(emptyNudgeState(), 'whats_new', 'forever', 1));
    await expect(hasUnseenOfflineSpotlight()).resolves.toBe(false);
  });

  it('never lights the pill in a screenshot run', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    await expect(hasUnseenOfflineSpotlight()).resolves.toBe(false);
  });
});
