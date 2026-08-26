// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const pushMock = vi.hoisted(() => vi.fn());
const segmentsCtrl = vi.hoisted(() => ({ segments: ['(tabs)', 'climbs'] as string[] }));
const hasSeenOnboardingMock = vi.hoisted(() => vi.fn());
const getInitialURLMock = vi.hoisted(() => vi.fn());
const listPrBranchesMock = vi.hoisted(() => vi.fn());
const readRunningPrNumberMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
const reportHandledErrorMock = vi.hoisted(() => vi.fn());
const settingsStore = vi.hoisted(() => ({ values: {} as Record<string, string | null> }));
const setSettingMock = vi.hoisted(() => vi.fn());
const profileCtrl = vi.hoisted(() => ({ id: 'user-a' as string | undefined, isTester: true as boolean | undefined }));
const surfingCtrl = vi.hoisted(() => ({ surfingBuild: true, ready: true }));
const updatesCtrl = vi.hoisted(() => ({ updateId: 'bundle-a' as string | null }));

vi.mock('expo-router', () => ({
  router: { push: pushMock },
  useSegments: () => segmentsCtrl.segments,
}));
vi.mock('expo-linking', () => ({ getInitialURL: getInitialURLMock }));
vi.mock('expo-updates', () => ({
  get updateId() {
    return updatesCtrl.updateId;
  },
}));
// Run the deferred work inline so each case is one awaited tick rather than a
// timer dance; the real InteractionManager only postpones it past the frame.
vi.mock('react-native', () => ({
  InteractionManager: {
    runAfterInteractions: (task: () => void) => {
      task();
      return { cancel: vi.fn() };
    },
  },
}));
vi.mock('../../../lib/onboarding/onboarding-storage', () => ({ hasSeenOnboarding: hasSeenOnboardingMock }));
vi.mock('../../../lib/graphql/hooks', () => ({
  useProfile: () => ({ data: profileCtrl.id ? { id: profileCtrl.id, isTester: profileCtrl.isTester } : undefined }),
}));
vi.mock('../../../lib/ota-branch-surfing-state', () => ({
  useOtaBranchSurfingState: () => surfingCtrl,
}));
vi.mock('../../../lib/qa/qa-surf', () => ({
  listPrBranches: listPrBranchesMock,
  readRunningPrNumber: readRunningPrNumberMock,
}));
vi.mock('../../../settings', () => ({
  getSetting: (key: string) => settingsStore.values[key] ?? null,
  setSetting: setSettingMock,
}));
vi.mock('../../../lib/analytics', () => ({ track: trackMock }));
vi.mock('../../../lib/error-reporting', () => ({ reportHandledError: reportHandledErrorMock }));

import { QaTesterGate, resetQaGateSessionForTests } from '../QaTesterGate';

function branchList(...prNumbers: number[]) {
  return prNumbers.map((prNumber) => ({
    prNumber,
    branch: `pr-${prNumber}`,
    lastUpdateAt: '2026-08-26T10:00:00.000Z',
  }));
}

beforeEach(() => {
  resetQaGateSessionForTests();
  pushMock.mockClear();
  trackMock.mockClear();
  setSettingMock.mockClear();
  reportHandledErrorMock.mockClear();
  hasSeenOnboardingMock.mockReset().mockResolvedValue(true);
  getInitialURLMock.mockReset().mockResolvedValue(null);
  listPrBranchesMock.mockReset().mockResolvedValue(branchList(4792, 4800));
  readRunningPrNumberMock.mockReset().mockReturnValue(null);
  settingsStore.values = {};
  profileCtrl.id = 'user-a';
  profileCtrl.isTester = true;
  surfingCtrl.surfingBuild = true;
  surfingCtrl.ready = true;
  updatesCtrl.updateId = 'bundle-a';
  delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
});

describe('QaTesterGate on production', () => {
  it('offers the pick list, seeded with the branches it just listed', async () => {
    render(<QaTesterGate ready />);
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith({
        pathname: '/qa/pick',
        // `origin` is what lets the pick screen tell this dismissal (a skipped
        // prompt) from the same screen opened by hand off the drawer.
        params: { prNumbers: '4792,4800', origin: 'launch' },
      }),
    );
    expect(trackMock).toHaveBeenCalledWith('QA Preview Prompted', { count: 2 });
  });

  it('stays quiet when nothing is published', async () => {
    listPrBranchesMock.mockResolvedValue([]);
    render(<QaTesterGate ready />);
    await waitFor(() => expect(listPrBranchesMock).toHaveBeenCalled());
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('stays quiet when surfing is switched off for this channel', async () => {
    listPrBranchesMock.mockResolvedValue(null);
    render(<QaTesterGate ready />);
    await waitFor(() => expect(listPrBranchesMock).toHaveBeenCalled());
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('reports an unreachable update server instead of surfacing it', async () => {
    // A failed launch prompt is our problem, not something to put in the
    // tester's face.
    listPrBranchesMock.mockRejectedValue(new Error('Could not reach the update server (502).'));
    render(<QaTesterGate ready />);
    await waitFor(() => expect(reportHandledErrorMock).toHaveBeenCalled());
    expect(reportHandledErrorMock.mock.calls[0][1]).toEqual({ tags: { source: 'qa', op: 'list-branches' } });
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe('QaTesterGate stays out of the way', () => {
  it('does nothing until the app is ready', async () => {
    render(<QaTesterGate ready={false} />);
    await Promise.resolve();
    expect(listPrBranchesMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('does nothing for a non-tester', async () => {
    profileCtrl.isTester = false;
    render(<QaTesterGate ready />);
    await Promise.resolve();
    expect(listPrBranchesMock).not.toHaveBeenCalled();
  });

  it('waits rather than deciding while the profile is still loading', async () => {
    // `isTester` is undefined on a cold offline start. Reading that as "no" would
    // switch QA off for everyone whose profile lands a second late.
    profileCtrl.isTester = undefined;
    const { rerender } = render(<QaTesterGate ready />);
    await Promise.resolve();
    expect(listPrBranchesMock).not.toHaveBeenCalled();

    profileCtrl.isTester = true;
    rerender(<QaTesterGate ready />);
    await waitFor(() => expect(pushMock).toHaveBeenCalled());
  });

  it("waits while a surfing build's migration is still settling", async () => {
    // That migration ends in a reload; a route pushed now is thrown away.
    surfingCtrl.ready = false;
    const { rerender } = render(<QaTesterGate ready />);
    await Promise.resolve();
    expect(listPrBranchesMock).not.toHaveBeenCalled();

    surfingCtrl.ready = true;
    rerender(<QaTesterGate ready />);
    await waitFor(() => expect(pushMock).toHaveBeenCalled());
  });

  it('does nothing on a build that cannot load a branch', async () => {
    surfingCtrl.surfingBuild = false;
    render(<QaTesterGate ready />);
    await Promise.resolve();
    expect(listPrBranchesMock).not.toHaveBeenCalled();
  });

  it('never prompts in screenshot mode', async () => {
    process.env.EXPO_PUBLIC_SCREENSHOT_MODE = '1';
    render(<QaTesterGate ready />);
    await Promise.resolve();
    expect(listPrBranchesMock).not.toHaveBeenCalled();
  });

  it('does not interrupt a join deep-link landing', async () => {
    segmentsCtrl.segments = ['join', '[sessionId]'];
    render(<QaTesterGate ready />);
    await Promise.resolve();
    expect(listPrBranchesMock).not.toHaveBeenCalled();
    segmentsCtrl.segments = ['(tabs)', 'climbs'];
  });

  it('does not cover a cold-start deep link that lands ON a tab', async () => {
    getInitialURLMock.mockResolvedValue('com.boardsesh.app://climbs/kilter');
    render(<QaTesterGate ready />);
    await waitFor(() => expect(getInitialURLMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('does not prompt before the first-run walkthrough has been seen', async () => {
    hasSeenOnboardingMock.mockResolvedValue(false);
    render(<QaTesterGate ready />);
    await waitFor(() => expect(hasSeenOnboardingMock).toHaveBeenCalled());
    await Promise.resolve();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('prompts once per session, not once per mount', async () => {
    const { unmount } = render(<QaTesterGate ready />);
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    unmount();

    render(<QaTesterGate ready />);
    await Promise.resolve();
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it('re-decides when a different user signs in mid-session', async () => {
    profileCtrl.isTester = false;
    const { rerender } = render(<QaTesterGate ready />);
    await Promise.resolve();
    expect(pushMock).not.toHaveBeenCalled();

    profileCtrl.id = 'user-b';
    profileCtrl.isTester = true;
    rerender(<QaTesterGate ready />);
    await waitFor(() => expect(pushMock).toHaveBeenCalled());
  });
});

describe('QaTesterGate on a preview bundle', () => {
  beforeEach(() => {
    readRunningPrNumberMock.mockReturnValue(4792);
  });

  it('shows the brief and remembers it for this bundle', async () => {
    render(<QaTesterGate ready />);
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/qa/brief'));
    expect(setSettingMock).toHaveBeenCalledWith('qaBriefSeenKey', 'user-a:pr-4792:bundle-a');
    expect(trackMock).toHaveBeenCalledWith('QA Brief Shown', { prNumber: 4792 });
  });

  it('never asks the update server for a branch list', async () => {
    // The brief is about the branch already running; listing is production-only.
    render(<QaTesterGate ready />);
    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    expect(listPrBranchesMock).not.toHaveBeenCalled();
  });

  it('re-briefs a second tester on a device where someone else already saw it', async () => {
    // The settings store is device-wide; the markers are account-scoped, so
    // user-a signing pr-4792 off must not cost user-b their brief.
    settingsStore.values.qaBriefSeenKey = 'user-a:pr-4792:bundle-a';
    settingsStore.values.qaVerdictSubmittedKey = 'user-a:pr-4792:bundle-a';
    profileCtrl.id = 'user-b';
    render(<QaTesterGate ready />);
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/qa/brief'));
    expect(setSettingMock).toHaveBeenCalledWith('qaBriefSeenKey', 'user-b:pr-4792:bundle-a');
  });

  it('does not show the brief twice for the same bundle', async () => {
    settingsStore.values.qaBriefSeenKey = 'user-a:pr-4792:bundle-a';
    render(<QaTesterGate ready />);
    await Promise.resolve();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('shows the brief again after the author pushes a new bundle', async () => {
    settingsStore.values.qaBriefSeenKey = 'user-a:pr-4792:bundle-a';
    updatesCtrl.updateId = 'bundle-b';
    render(<QaTesterGate ready />);
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/qa/brief'));
  });

  it('stays quiet once a verdict has been filed for this bundle', async () => {
    // Leaving a preview usually can't reload the app, so the tester keeps
    // running it — without this marker they would be re-briefed every launch.
    settingsStore.values.qaVerdictSubmittedKey = 'user-a:pr-4792:bundle-a';
    render(<QaTesterGate ready />);
    await Promise.resolve();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
