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
}));

const spies = vi.hoisted(() => ({
  push: vi.fn(),
  track: vi.fn(),
  // Typed loosely on purpose: the pill assertion below reads the saved state
  // back out of the call args, so the parameter has to exist in the signature.
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
vi.mock('../../../theme/tokens', () => ({ spacing: new Proxy({}, { get: () => 4 }), borderRadius: { lg: 12 } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryBackground: '#eee', separator: '#ccc', secondaryLabel: '#888' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: spies.push }) }));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: state.activeBoard }) }));
vi.mock('../../../offline/use-downloaded-scope-keys', () => ({
  useDownloadedScopeKeys: () => ({ data: state.downloadedScopeKeys }),
}));
vi.mock('../../../providers/feature-flags-provider', () => ({
  useOfflineDownloadsEnabled: () => state.offlineEngineEnabled,
}));
vi.mock('../../../hooks/use-is-offline', () => ({ useIsOffline: () => false }));
vi.mock('../../../settings', () => ({
  offlineBoardKeyForBoard: (board: UserBoard) => `${board.boardType}:${board.layoutId}:${board.sizeId}`,
  useSetting: (key: string) => [key === 'syncEnabledBoards' ? state.enabledBoards : state.autoOfflineBoards, vi.fn()],
}));
vi.mock('../../../lib/analytics', () => ({ track: spies.track }));
vi.mock('../../../lib/offline-nudges/nudge-storage', async () => {
  const policy = await import('../../../lib/offline-nudges/nudge-policy');
  return { loadNudgeState: async () => policy.emptyNudgeState(), saveNudgeState: spies.saveNudgeState };
});

import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { OfflineNudgeState } from '../../../lib/offline-nudges/nudge-policy';
import { OfflineSpotlightCard } from '../OfflineSpotlightCard';

const board = { uuid: 'garage', name: 'Gym wall', boardType: 'kilter', layoutId: 1, sizeId: 10 } as UserBoard;

beforeEach(() => {
  vi.clearAllMocks();
  state.activeBoard = board;
  state.enabledBoards = [];
  state.downloadedScopeKeys = [];
  state.autoOfflineBoards = false;
  state.offlineEngineEnabled = true;
});
afterEach(() => cleanup());

async function renderSpotlight() {
  render(createElement(OfflineSpotlightCard, {}));
  await screen.findByTestId('offline-spotlight-card').catch(() => null);
}

describe('OfflineSpotlightCard', () => {
  it('introduces offline downloads to someone who has none', async () => {
    await renderSpotlight();
    expect(screen.getByTestId('offline-spotlight-card')).toBeTruthy();
  });

  it('takes itself away once a board is already offline', async () => {
    state.enabledBoards = ['kilter:1:10'];
    await renderSpotlight();
    expect(screen.queryByTestId('offline-spotlight-card')).toBeNull();
  });

  // It's an introduction, not a confirmation — the size quote lives on My Boards.
  it('sends the user to My Boards rather than downloading under them', async () => {
    await renderSpotlight();
    fireEvent.click(screen.getByText('mobile.offline.nudge.spotlight.cta'));
    expect(spies.push).toHaveBeenCalledWith('/boards/manage');
    expect(spies.track).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineNudgeAccepted,
      expect.objectContaining({ surface: 'whats_new' }),
    );
  });

  // The handoff is a drop-off risk: someone can open My Boards and back out
  // without downloading anything. The spotlight must stay "seen" all the same,
  // or hasUnseenOfflineSpotlight lights the What's New "New" pill again for a
  // card the user already opened and accepted.
  it('keeps the spotlight marked as seen after the handoff', async () => {
    await renderSpotlight();
    await waitFor(() => expect(spies.saveNudgeState).toHaveBeenCalled());
    fireEvent.click(screen.getByText('mobile.offline.nudge.spotlight.cta'));

    await waitFor(() => expect(spies.saveNudgeState).toHaveBeenCalledTimes(2));
    const saved = spies.saveNudgeState.mock.calls[1][0] as OfflineNudgeState;
    expect(saved.surfaces.whats_new.shownCount).toBe(1);
  });

  it('persists a dismissal as forever, with no "not now" half-measure', async () => {
    await renderSpotlight();
    expect(screen.queryByText('mobile.offline.nudge.notNow')).toBeNull();
    fireEvent.click(screen.getByText('mobile.offline.nudge.never'));
    expect(spies.track).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineNudgeDismissed,
      expect.objectContaining({ surface: 'whats_new', dismissKind: 'forever' }),
    );
    expect(screen.queryByTestId('offline-spotlight-card')).toBeNull();
  });
});
