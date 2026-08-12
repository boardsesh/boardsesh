// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

const state = vi.hoisted(() => ({
  activeBoard: null as UserBoard | null,
  enabledBoards: [] as string[],
  downloadedScopeKeys: [] as string[],
  autoOfflineBoards: false,
  offlineEngineEnabled: true,
  nudgesEnabled: true,
  isOffline: false,
  nudgeState: null as unknown,
}));

const spies = vi.hoisted(() => ({
  confirmAndDownload: vi.fn(async () => true),
  setSetting: vi.fn(),
  track: vi.fn(),
  saveNudgeState: vi.fn(async () => undefined),
}));

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => createElement('span', { 'data-icon': 'true' }) }));
vi.mock('../../Button', () => ({
  Button: ({ title, onPress }: { title: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, title),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: new Proxy({}, { get: () => 4 }),
  borderRadius: { lg: 12 },
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryBackground: '#eee', separator: '#ccc', secondaryLabel: '#888' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: state.activeBoard }),
}));
vi.mock('../../../offline/use-confirm-board-download', () => ({
  useConfirmBoardDownload: () => ({ confirmAndDownload: spies.confirmAndDownload, armWithoutConfirm: vi.fn() }),
}));
vi.mock('../../../offline/use-downloaded-scope-keys', () => ({
  useDownloadedScopeKeys: () => ({ data: state.downloadedScopeKeys }),
}));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useOfflineDownloadsEnabled: () => state.offlineEngineEnabled,
  useOfflineNudgesEnabled: () => state.nudgesEnabled,
}));
vi.mock('../../../hooks/use-is-offline', () => ({ useIsOffline: () => state.isOffline }));
vi.mock('../../../settings', () => ({
  offlineBoardKeyForBoard: (board: UserBoard) => `${board.boardType}:${board.layoutId}:${board.sizeId}`,
  useSetting: (key: string) => [key === 'syncEnabledBoards' ? state.enabledBoards : state.autoOfflineBoards, vi.fn()],
  getSetting: (key: string) => (key === 'syncEnabledBoards' ? state.enabledBoards : state.autoOfflineBoards),
  setSetting: spies.setSetting,
}));
vi.mock('../../../lib/analytics', () => ({ track: spies.track }));
vi.mock('../../../lib/offline-nudges/nudge-storage', async () => {
  const policy = await import('../../../lib/offline-nudges/nudge-policy');
  return {
    loadNudgeState: async () => state.nudgeState ?? policy.emptyNudgeState(),
    saveNudgeState: spies.saveNudgeState,
  };
});

import { SHARED_EVENTS } from '@boardsesh/analytics';
import { suppressedNudgeState } from '../../../lib/offline-nudges/nudge-policy';
import { PostSessionOfflineNudge } from '../PostSessionOfflineNudge';

const board = { uuid: 'garage', name: "Marco's garage", boardType: 'kilter', layoutId: 1, sizeId: 10 } as UserBoard;

beforeEach(() => {
  vi.clearAllMocks();
  state.activeBoard = board;
  state.enabledBoards = [];
  state.downloadedScopeKeys = [];
  state.autoOfflineBoards = false;
  state.offlineEngineEnabled = true;
  state.nudgesEnabled = true;
  state.isOffline = false;
  state.nudgeState = null;
});
afterEach(() => cleanup());

async function renderNudge(storeReviewWillPrompt = false) {
  const result = render(createElement(PostSessionOfflineNudge, { storeReviewWillPrompt }));
  // The persisted nudge state loads asynchronously; nothing renders before it.
  await screen.findByTestId('post-session-offline-nudge').catch(() => null);
  return result;
}

describe('PostSessionOfflineNudge', () => {
  it('offers the download for an un-downloaded active board', async () => {
    await renderNudge();
    expect(screen.getByTestId('post-session-offline-nudge')).toBeTruthy();
    await waitFor(() =>
      expect(spies.track).toHaveBeenCalledWith(
        SHARED_EVENTS.OfflineNudgeShown,
        expect.objectContaining({ surface: 'post_session', scopeKey: 'kilter:1:10', downloadedBoardCount: 0 }),
      ),
    );
  });

  it('fires the impression once across re-renders', async () => {
    const { rerender } = await renderNudge();
    rerender(createElement(PostSessionOfflineNudge, { storeReviewWillPrompt: false }));
    rerender(createElement(PostSessionOfflineNudge, { storeReviewWillPrompt: false }));
    await waitFor(() =>
      expect(spies.track.mock.calls.filter(([event]) => event === SHARED_EVENTS.OfflineNudgeShown)).toHaveLength(1),
    );
  });

  it('stands down when the store review is going to prompt', async () => {
    await renderNudge(true);
    expect(screen.queryByTestId('post-session-offline-nudge')).toBeNull();
  });

  // The regression the naive "suppress on isSessionStoreReviewEligible" design
  // would have shipped: on a ≥3-send session with the review on cooldown, the
  // offline prompt is exactly what should appear.
  it('still shows when the review candidate resolved to no prompt', async () => {
    await renderNudge(false);
    expect(screen.getByTestId('post-session-offline-nudge')).toBeTruthy();
  });

  it.each([
    ['already enabled', () => (state.enabledBoards = ['kilter:1:10'])],
    ['auto-downloading every board', () => (state.autoOfflineBoards = true)],
    ['the offline engine is off', () => (state.offlineEngineEnabled = false)],
    ['the nudge flag is off', () => (state.nudgesEnabled = false)],
    ['dismissed forever', () => (state.nudgeState = suppressedNudgeState())],
    ['there is no active board', () => (state.activeBoard = null)],
  ])('renders nothing when %s', async (_label, mutate) => {
    mutate();
    await renderNudge();
    expect(screen.queryByTestId('post-session-offline-nudge')).toBeNull();
  });

  it('starts a real download on accept and reports it as not arm-only', async () => {
    await renderNudge();
    fireEvent.click(screen.getByText('mobile.offline.nudge.postSession.cta'));

    expect(spies.confirmAndDownload).toHaveBeenCalledWith(board);
    expect(spies.track).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineNudgeAccepted,
      expect.objectContaining({ surface: 'post_session', armedOnly: false }),
    );
  });

  it('turns on auto-download from the secondary action', async () => {
    await renderNudge();
    fireEvent.click(screen.getByText('mobile.offline.nudge.postSession.allBoardsCta'));

    expect(spies.setSetting).toHaveBeenCalledWith('autoOfflineBoards', true);
    expect(spies.confirmAndDownload).toHaveBeenCalledWith(board);
  });

  it.each([
    ['mobile.offline.nudge.notNow', 'once'],
    ['mobile.offline.nudge.never', 'forever'],
  ])('reports %s as dismissKind %s', async (label, dismissKind) => {
    await renderNudge();
    fireEvent.click(screen.getByText(label));

    expect(spies.track).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineNudgeDismissed,
      expect.objectContaining({ surface: 'post_session', dismissKind }),
    );
    expect(screen.queryByTestId('post-session-offline-nudge')).toBeNull();
  });
});
