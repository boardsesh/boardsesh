// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';

const state = vi.hoisted(() => ({
  enabledBoards: [] as string[],
  downloadedScopeKeys: [] as string[],
  autoOfflineBoards: false,
  offlineEngineEnabled: true,
  // This surface exists for the no-signal case, so offline is the default here.
  isOffline: true,
}));

const spies = vi.hoisted(() => ({
  armWithoutConfirm: vi.fn(),
  confirmAndDownload: vi.fn(async () => true),
  showToast: vi.fn(),
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
vi.mock('../../../theme/tokens', () => ({ spacing: new Proxy({}, { get: () => 4 }), borderRadius: { lg: 12 } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { secondaryBackground: '#eee', separator: '#ccc', secondaryLabel: '#888' },
    brandColors: { primary: '#6D28D9' },
  }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: spies.showToast }) }));
vi.mock('../../../offline/use-confirm-board-download', () => ({
  useConfirmBoardDownload: () => ({
    confirmAndDownload: spies.confirmAndDownload,
    armWithoutConfirm: spies.armWithoutConfirm,
  }),
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
  useSetting: (key: string) => [key === 'syncEnabledBoards' ? state.enabledBoards : state.autoOfflineBoards, vi.fn()],
}));
vi.mock('../../../lib/analytics', () => ({ track: spies.track }));
vi.mock('../../../lib/offline-nudges/nudge-storage', async () => {
  const policy = await import('../../../lib/offline-nudges/nudge-policy');
  return { loadNudgeState: async () => policy.emptyNudgeState(), saveNudgeState: spies.saveNudgeState };
});

import { SHARED_EVENTS } from '@boardsesh/analytics';
import { OfflineCatalogCta } from '../OfflineCatalogCta';

const board = { uuid: 'garage', name: 'Gym wall', boardType: 'tension', layoutId: 8, sizeId: 25 } as UserBoard;

beforeEach(() => {
  vi.clearAllMocks();
  state.enabledBoards = [];
  state.downloadedScopeKeys = [];
  state.autoOfflineBoards = false;
  state.offlineEngineEnabled = true;
  state.isOffline = true;
});
afterEach(() => cleanup());

async function renderCta(boardProp: UserBoard | null = board) {
  render(createElement(OfflineCatalogCta, { board: boardProp }));
  await screen.findByTestId('offline-catalog-cta').catch(() => null);
}

describe('OfflineCatalogCta', () => {
  it('offers the download in place of the dead-end empty state', async () => {
    await renderCta();
    expect(screen.getByTestId('offline-catalog-cta')).toBeTruthy();
  });

  // The whole point of the arm-only design: a cycle kicked from here would burn
  // a bootstrap attempt per tap on captive-portal wifi (#4313).
  it('arms the board without starting a download, and says so', async () => {
    await renderCta();
    fireEvent.click(screen.getByText('mobile.offline.nudge.noCatalog.cta'));

    expect(spies.armWithoutConfirm).toHaveBeenCalledWith(board);
    expect(spies.confirmAndDownload).not.toHaveBeenCalled();
    expect(spies.showToast).toHaveBeenCalledWith('mobile.offline.nudge.noCatalog.armedToast', 'success');
  });

  it('reports the accept as arm-only so the funnel does not look broken', async () => {
    await renderCta();
    fireEvent.click(screen.getByText('mobile.offline.nudge.noCatalog.cta'));

    expect(spies.track).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineNudgeAccepted,
      expect.objectContaining({ surface: 'no_catalog', scopeKey: 'tension:8:25', armedOnly: true }),
    );
  });

  // The case `armedOnly` was invented for, and the one a connectivity probe gets
  // wrong: the boards picker reaches this CTA on captive-portal wifi, where
  // `useIsOffline()` reads ONLINE. Nothing downloads there either, so filing the
  // accept as a started download promises a completion that never arrives.
  it('still reports arm-only when the connection lies about being online', async () => {
    state.isOffline = false;
    await renderCta();
    fireEvent.click(screen.getByText('mobile.offline.nudge.noCatalog.cta'));

    expect(spies.armWithoutConfirm).toHaveBeenCalledWith(board);
    expect(spies.track).toHaveBeenCalledWith(
      SHARED_EVENTS.OfflineNudgeAccepted,
      expect.objectContaining({ surface: 'no_catalog', armedOnly: true }),
    );
  });

  // No cooldown, no lifetime cap: an affordance that hides itself is the dead
  // end this replaced. Only "already armed / downloaded" takes it away.
  it('has no dismiss affordance at all', async () => {
    await renderCta();
    expect(screen.queryByText('mobile.offline.nudge.notNow')).toBeNull();
    expect(screen.queryByText('mobile.offline.nudge.never')).toBeNull();
  });

  it.each([
    ['the scope is already armed', () => (state.enabledBoards = ['tension:8:25'])],
    ['the offline engine is off', () => (state.offlineEngineEnabled = false)],
    ['there is no board', () => undefined],
  ])('renders nothing when %s', async (label, mutate) => {
    mutate();
    await renderCta(label === 'there is no board' ? null : board);
    expect(screen.queryByTestId('offline-catalog-cta')).toBeNull();
  });

  it('keeps firing the impression across repeat visits rather than capping itself', async () => {
    await renderCta();
    cleanup();
    await renderCta();
    await waitFor(() =>
      expect(spies.track.mock.calls.filter(([event]) => event === SHARED_EVENTS.OfflineNudgeShown)).toHaveLength(2),
    );
  });
});
