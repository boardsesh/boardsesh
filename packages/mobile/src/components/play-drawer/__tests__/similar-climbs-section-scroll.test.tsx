// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Regression guard for the Android nested-scroll fix (issue #3506): like the beta
// strip, the Similar Climbs strip lives inside the play drawer's RNGH ScrollView,
// so it must scroll with react-native-gesture-handler's ScrollView — a plain
// react-native ScrollView can't scroll there on Android. Distinct stubs let us
// assert the strip's scroller came from the gesture-handler module.
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
  ScrollView: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'rn-scroll' }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

vi.mock('react-native-gesture-handler', () => ({
  ScrollView: ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': 'rngh-scroll' }, children),
}));

const similar = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  isError: false,
  source: 'local' as 'local' | 'network' | 'download',
  isResolvingSource: false,
  scopes: [] as unknown[],
}));

const offer = vi.hoisted(() => ({
  activeBoard: null as null | { boardType: string; layoutId: number; sizeId: number; name: string },
  nudgeVisible: true,
  nudgeBoards: [] as unknown[],
  enabledScopeKeys: [] as string[],
  isOffline: false,
  confirmAndDownload: vi.fn(async () => true),
  armWithoutConfirm: vi.fn(),
  accept: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../Icon', () => ({ Icon: () => null }));
vi.mock('../../ClimbListThumbnail', () => ({ ClimbListThumbnail: () => null }));
vi.mock('../similar-climbs-utils', () => ({
  rankBySizeCompatibility: () => [
    {
      climb: { uuid: 'sc-1', name: 'Test Similar', difficultyName: 'V4', frames: '', layoutId: 1 },
      compatible: true,
    },
  ],
  buildClimbStub: () => ({ uuid: 'sc-1' }),
  formatByline: () => '',
}));
vi.mock('../../../lib/graphql/hooks', () => ({
  useSimilarClimbs: (scope: unknown) => {
    similar.scopes.push(scope);
    return {
      data: similar.data,
      isLoading: similar.isLoading,
      isError: similar.isError,
      refetch: vi.fn(),
      source: similar.source,
      isResolvingSource: similar.isResolvingSource,
    };
  },
}));
vi.mock('../../../lib/graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: offer.activeBoard }) }));
vi.mock('../../../lib/offline-nudges/use-offline-nudge', () => ({
  useOfflineNudge: ({ board }: { board: unknown }) => {
    offer.nudgeBoards.push(board);
    return { visible: offer.nudgeVisible && board != null, accept: offer.accept, dismiss: vi.fn() };
  },
}));
vi.mock('../../../offline/use-confirm-board-download', () => ({
  useConfirmBoardDownload: () => ({
    confirmAndDownload: offer.confirmAndDownload,
    armWithoutConfirm: offer.armWithoutConfirm,
  }),
}));
vi.mock('../../../settings', () => ({
  offlineBoardKeyForBoard: (board: { boardType: string; layoutId: number; sizeId: number }) =>
    `${board.boardType}:${board.layoutId}:${board.sizeId}`,
  useSetting: () => [offer.enabledScopeKeys, vi.fn()],
}));
vi.mock('../../../hooks/use-is-offline', () => ({ useIsOffline: () => offer.isOffline }));
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: offer.showToast }) }));
vi.mock('../../offline/OfflineNudgeCard', () => ({
  OfflineNudgeCard: ({
    title,
    primaryLabel,
    onPrimary,
  }: {
    title: string;
    primaryLabel: string;
    onPrimary: () => void;
  }) =>
    createElement(
      'div',
      { 'data-testid': 'offline-nudge-card' },
      createElement('span', null, title),
      createElement('button', { onClick: onPrimary }, primaryLabel),
    ),
}));
vi.mock('../../../hooks/use-display-grade', () => ({
  useDisplayGrade: () => ({ resolveGrade: () => ({ label: 'V4', color: '#333' }) }),
}));
vi.mock('../../../providers/theme-provider', () => ({ useTheme: () => ({ brandColors: { primary: '#000' } }) }));
vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { systemGray: '#888', white: '#fff' } }));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8, 3: 12, 16: 64 },
  borderRadius: { md: 8, full: 999 },
}));

import { SimilarClimbsSection } from '../SimilarClimbsSection';

const props = {
  climbUuid: 'climb-1',
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: '1',
  angle: 40,
  onClimbPress: vi.fn(),
};
const garage = { boardType: 'kilter', layoutId: 1, sizeId: 10, name: 'Garage' };

beforeEach(() => {
  vi.clearAllMocks();
  similar.data = [{ uuid: 'sc-1' }];
  similar.isLoading = false;
  similar.isError = false;
  similar.source = 'local';
  similar.isResolvingSource = false;
  similar.scopes = [];
  offer.activeBoard = garage;
  offer.nudgeVisible = true;
  offer.nudgeBoards = [];
  offer.enabledScopeKeys = [];
  offer.isOffline = false;
  offer.confirmAndDownload.mockResolvedValue(true);
});

describe('SimilarClimbsSection', () => {
  it('scrolls the loaded strip with the gesture-handler ScrollView (Android nested-scroll fix)', () => {
    const { getByTestId, queryByTestId } = render(
      createElement(SimilarClimbsSection, {
        climbUuid: 'climb-1',
        boardName: 'kilter',
        layoutId: 1,
        sizeId: 10,
        setIds: '1',
        angle: 40,
        onClimbPress: vi.fn(),
      }),
    );

    expect(getByTestId('rngh-scroll')).toBeTruthy();
    expect(queryByTestId('rn-scroll')).toBeNull();
  });
});

describe('SimilarClimbsSection — source states', () => {
  it('local: asks for the drawer scope (size included) and renders the strip', () => {
    const { getByText, queryByTestId } = render(createElement(SimilarClimbsSection, props));
    expect(similar.scopes.at(-1)).toEqual({ boardName: 'kilter', layoutId: 1, sizeId: 10 });
    expect(getByText('Test Similar')).toBeTruthy();
    expect(queryByTestId('offline-nudge-card')).toBeNull();
  });

  it('local, first index build: shows the skeleton and says it is preparing', () => {
    similar.isLoading = true;
    const { getByText } = render(createElement(SimilarClimbsSection, props));
    expect(getByText('mobile.similarClimbs.preparing')).toBeTruthy();
  });

  it('network (admin): renders the strip with no download offer and no preparing copy', () => {
    similar.source = 'network';
    const { getByText, queryByTestId, queryByText } = render(createElement(SimilarClimbsSection, props));
    expect(getByText('Test Similar')).toBeTruthy();
    expect(queryByTestId('offline-nudge-card')).toBeNull();
    similar.isLoading = true;
    const loading = render(createElement(SimilarClimbsSection, props));
    expect(loading.queryAllByText('mobile.similarClimbs.preparing')).toHaveLength(0);
    expect(queryByText('mobile.similarClimbs.preparing')).toBeNull();
  });

  it('while the source resolves: skeleton, never a flash of the download offer', () => {
    similar.source = 'download';
    similar.isResolvingSource = true;
    const { queryByTestId } = render(createElement(SimilarClimbsSection, props));
    expect(queryByTestId('offline-nudge-card')).toBeNull();
  });

  it('download: offers the active board and starts an attributed download', async () => {
    similar.source = 'download';
    similar.data = undefined;
    const { getByTestId, getByText } = render(createElement(SimilarClimbsSection, props));
    expect(getByTestId('offline-nudge-card')).toBeTruthy();
    expect(getByText('mobile.offline.nudge.similarClimbs.title')).toBeTruthy();
    await act(async () => {
      fireEvent.click(getByText('mobile.offline.nudge.similarClimbs.cta'));
    });
    expect(offer.confirmAndDownload).toHaveBeenCalledWith(garage, { trigger: 'similar_climbs', source: 'play_drawer' });
    expect(offer.accept).toHaveBeenCalledWith('download');
  });

  it('download while offline: arms the board instead of kicking a doomed download', async () => {
    similar.source = 'download';
    offer.isOffline = true;
    const { getByText } = render(createElement(SimilarClimbsSection, props));
    await act(async () => {
      fireEvent.click(getByText('mobile.offline.nudge.similarClimbs.cta'));
    });
    expect(offer.confirmAndDownload).not.toHaveBeenCalled();
    expect(offer.armWithoutConfirm).toHaveBeenCalledWith(garage, { trigger: 'similar_climbs', source: 'play_drawer' });
    expect(offer.accept).toHaveBeenCalledWith('armed');
  });

  it('download on a climb from another board: plain empty state, no offer', () => {
    similar.source = 'download';
    offer.activeBoard = { ...garage, sizeId: 11 };
    const { getByText, queryByTestId } = render(createElement(SimilarClimbsSection, props));
    expect(queryByTestId('offline-nudge-card')).toBeNull();
    expect(offer.nudgeBoards.at(-1)).toBeNull();
    expect(getByText('mobile.similarClimbs.empty')).toBeTruthy();
  });

  it('download already asked for: says the strip arrives with the download', () => {
    similar.source = 'download';
    offer.nudgeVisible = false;
    offer.enabledScopeKeys = ['kilter:1:10'];
    const { getByText } = render(createElement(SimilarClimbsSection, props));
    expect(getByText('mobile.similarClimbs.waitingForDownload')).toBeTruthy();
  });
});
