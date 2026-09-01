// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

const state = vi.hoisted(() => ({
  activeBoard: null as UserBoard | null,
  myBoards: [] as UserBoard[],
  enabledBoards: [] as string[],
  downloadedScopeKeys: [] as string[],
  autoOfflineBoards: false,
  offlineEngineEnabled: true,
  isOffline: false,
  nudgeState: null as unknown,
}));

const spies = vi.hoisted(() => ({
  confirmAndDownload: vi.fn(async () => true),
  enableBoardsOffline: vi.fn(),
  setSetting: vi.fn(),
  track: vi.fn(),
  // Typed loosely on purpose: the assertions below read the saved state back
  // out of the call args, so the parameter has to exist in the spy's signature.
  saveNudgeState: vi.fn(async (_next: unknown) => undefined),
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
vi.mock('../../../lib/graphql/hooks', () => ({
  useMyBoards: (_input: unknown, options?: { enabled?: boolean }) => ({
    data: options?.enabled === false ? undefined : { boards: state.myBoards },
  }),
}));
vi.mock('../../../offline/use-confirm-board-download', () => ({
  useConfirmBoardDownload: () => ({ confirmAndDownload: spies.confirmAndDownload, armWithoutConfirm: vi.fn() }),
}));
vi.mock('../../../offline/use-board-downloads', () => ({
  useBoardDownloads: () => ({ enableBoardsOffline: spies.enableBoardsOffline, armBoardsOffline: vi.fn() }),
}));
vi.mock('../../../offline/use-downloaded-scope-keys', () => ({
  useDownloadedScopeKeys: () => ({ data: state.downloadedScopeKeys }),
}));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useOfflineDownloadsEnabled: () => state.offlineEngineEnabled,
}));
vi.mock('../../../hooks/use-is-offline', () => ({ useIsOffline: () => state.isOffline }));
vi.mock('../../../settings', () => ({
  offlineBoardKeyForBoard: (board: UserBoard) => `${board.boardType}:${board.layoutId}:${board.sizeId}`,
  offlineBoardScopeForBoard: (board: UserBoard) => board,
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
import { suppressedNudgeState, type OfflineNudgeState } from '../../../lib/offline-nudges/nudge-policy';
import { PostSessionOfflineNudge } from '../PostSessionOfflineNudge';

const board = { uuid: 'garage', name: "Marco's garage", boardType: 'kilter', layoutId: 1, sizeId: 10 } as UserBoard;

beforeEach(() => {
  vi.clearAllMocks();
  state.activeBoard = board;
  state.myBoards = [board];
  state.enabledBoards = [];
  state.downloadedScopeKeys = [];
  state.autoOfflineBoards = false;
  state.offlineEngineEnabled = true;
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
    await waitFor(() =>
      expect(spies.track).toHaveBeenCalledWith(
        SHARED_EVENTS.OfflineNudgeAccepted,
        expect.objectContaining({ surface: 'post_session', armedOnly: false }),
      ),
    );
  });

  // `armedOnly` reports the action taken, never a connectivity reading. The
  // probe is a heuristic in both directions, so a confirmed download stays a
  // download even on a device that reads offline — otherwise the funnel writes
  // off a completion it should be counting.
  it('reports a confirmed download as not arm-only even when the device reads offline', async () => {
    state.isOffline = true;
    await renderNudge();
    fireEvent.click(screen.getByText('mobile.offline.nudge.postSession.cta'));

    await waitFor(() =>
      expect(spies.track).toHaveBeenCalledWith(
        SHARED_EVENTS.OfflineNudgeAccepted,
        expect.objectContaining({ surface: 'post_session', armedOnly: false }),
      ),
    );
  });

  // The size dialog is the consent gate: counting a cancel as an accept would
  // inflate the funnel and start the 30-day quiet period on a "no".
  it('records nothing when the size dialog is cancelled', async () => {
    spies.confirmAndDownload.mockResolvedValueOnce(false);
    await renderNudge();
    fireEvent.click(screen.getByText('mobile.offline.nudge.postSession.cta'));

    await waitFor(() => expect(spies.confirmAndDownload).toHaveBeenCalled());
    expect(spies.track).not.toHaveBeenCalledWith(SHARED_EVENTS.OfflineNudgeAccepted, expect.anything());
  });

  it('turns on auto-download from the secondary action', async () => {
    await renderNudge();
    fireEvent.click(screen.getByText('mobile.offline.nudge.postSession.allBoardsCta'));

    expect(spies.confirmAndDownload).toHaveBeenCalledWith(board);
    await waitFor(() => expect(spies.setSetting).toHaveBeenCalledWith('autoOfflineBoards', true));
  });

  // The setting alone only reaches the other boards when the More screen next
  // mounts, so "download all my boards" used to download one.
  it('downloads the boards the user already owns, not just the active one', async () => {
    const otherBoard = { uuid: 'gym', name: 'The gym', boardType: 'tension', layoutId: 8, sizeId: 25 } as UserBoard;
    state.myBoards = [board, otherBoard];
    // confirmAndDownload has enabled the active board by the time we expand.
    spies.confirmAndDownload.mockImplementationOnce(async () => {
      state.enabledBoards = ['kilter:1:10'];
      return true;
    });
    await renderNudge();
    fireEvent.click(screen.getByText('mobile.offline.nudge.postSession.allBoardsCta'));

    await waitFor(() => expect(spies.enableBoardsOffline).toHaveBeenCalledWith([otherBoard]));
  });

  // Re-enabling the board confirmAndDownload just enabled would kick a second
  // sync cycle for a download already in flight.
  it('leaves the board the dialog just started alone', async () => {
    spies.confirmAndDownload.mockImplementationOnce(async () => {
      state.enabledBoards = ['kilter:1:10'];
      return true;
    });
    await renderNudge();
    fireEvent.click(screen.getByText('mobile.offline.nudge.postSession.allBoardsCta'));

    await waitFor(() => expect(spies.setSetting).toHaveBeenCalled());
    expect(spies.enableBoardsOffline).not.toHaveBeenCalled();
  });

  // Cancelling must not leave the user opted into downloading every board they
  // own — that is the opposite of what they just said.
  it('leaves auto-download alone when the size dialog is cancelled', async () => {
    spies.confirmAndDownload.mockResolvedValueOnce(false);
    await renderNudge();
    fireEvent.click(screen.getByText('mobile.offline.nudge.postSession.allBoardsCta'));

    await waitFor(() => expect(spies.confirmAndDownload).toHaveBeenCalled());
    expect(spies.setSetting).not.toHaveBeenCalled();
  });

  // The impression is a write too. Building accept/dismiss on the pre-impression
  // state saved shownCount back to 0 and dropped lastPromptAtMs, so an accepted
  // or dismissed prompt stopped counting against the three-show lifetime cap and
  // stopped holding off the cross-surface cooldown.
  it('keeps the impression it just recorded when the download is accepted', async () => {
    await renderNudge();
    await waitFor(() => expect(spies.saveNudgeState).toHaveBeenCalled());
    fireEvent.click(screen.getByText('mobile.offline.nudge.postSession.cta'));

    await waitFor(() => expect(spies.saveNudgeState).toHaveBeenCalledTimes(2));
    const saved = spies.saveNudgeState.mock.calls[1][0] as OfflineNudgeState;
    expect(saved.surfaces.post_session.shownCount).toBe(1);
    expect(saved.lastPromptAtMs).not.toBeNull();
    expect(saved.lastAcceptedAtMs).not.toBeNull();
  });

  it('keeps the impression it just recorded when the prompt is dismissed', async () => {
    await renderNudge();
    await waitFor(() => expect(spies.saveNudgeState).toHaveBeenCalled());
    fireEvent.click(screen.getByText('mobile.offline.nudge.notNow'));

    const saved = spies.saveNudgeState.mock.calls[1][0] as OfflineNudgeState;
    expect(saved.surfaces.post_session.shownCount).toBe(1);
    expect(saved.lastPromptAtMs).not.toBeNull();
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
