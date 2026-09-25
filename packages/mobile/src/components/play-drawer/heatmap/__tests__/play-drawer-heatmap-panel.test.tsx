// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBoard } from '@boardsesh/shared-schema';

vi.mock('react-native', () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('div', { 'data-testid': testID }, children),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) =>
    createElement('button', { onClick: onPress }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} },
}));

const offer = vi.hoisted(() => ({
  nudgeVisible: true,
  confirmAndDownload: vi.fn(async () => true),
  accept: vi.fn(),
  nudgeSurfaces: [] as string[],
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => (values?.summary ? `${key}:${values.summary}` : key),
  }),
}));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../SegmentedControl', () => ({
  SegmentedControl: ({ onSelect }: { onSelect: (key: string) => void }) =>
    createElement('button', { 'data-testid': 'mode-difficulty', onClick: () => onSelect('difficulty') }, 'modes'),
}));
vi.mock('../../../offline/OfflineNudgeCard', () => ({
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
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { secondaryLabel: '#888', separator: '#ccc' }, brandColors: { primary: '#000' } }),
}));
vi.mock('../../../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8, 4: 16 }, borderRadius: { sm: 4, full: 999 } }));
vi.mock('../../../../lib/graphql/hooks', () => ({ useGrades: () => ({ data: [] }) }));
vi.mock('../../../../lib/filter-summary', () => ({ getFilterSummary: () => 'V4–V6' }));
vi.mock('../../../../lib/offline-nudges/use-offline-nudge', () => ({
  useOfflineNudge: ({ surface, board }: { surface: string; board: unknown }) => {
    offer.nudgeSurfaces.push(surface);
    return { visible: offer.nudgeVisible && board != null, accept: offer.accept, dismiss: vi.fn() };
  },
}));
vi.mock('../../../../offline/use-confirm-board-download', () => ({
  useConfirmBoardDownload: () => ({ confirmAndDownload: offer.confirmAndDownload }),
}));

import { PlayDrawerHeatmapPanel } from '../PlayDrawerHeatmapPanel';
import type { PlayDrawerHeatmap } from '../use-play-drawer-heatmap';

const board = { boardType: 'kilter', layoutId: 1, sizeId: 10, name: 'Home Kilter' } as UserBoard;

function heatmap(overrides: Partial<PlayDrawerHeatmap> = {}): PlayDrawerHeatmap {
  return {
    enabled: true,
    toggle: vi.fn(),
    mode: 'uses',
    setMode: vi.fn(),
    search: null,
    wholeBoard: false,
    toggleWholeBoard: vi.fn(),
    source: 'local',
    isResolving: false,
    filterUnsupported: false,
    isBusy: false,
    isError: false,
    isEmpty: false,
    overlay: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  offer.nudgeVisible = true;
  offer.nudgeSurfaces = [];
});

describe('PlayDrawerHeatmapPanel', () => {
  it('renders nothing while the heatmap is off', () => {
    const { container } = render(
      createElement(PlayDrawerHeatmapPanel, {
        heatmap: heatmap({ enabled: false }),
        boardName: 'kilter',
        nudgeBoard: board,
      }),
    );
    expect(container.innerHTML).toBe('');
  });

  it('offers the download for a board that is not on the phone, and starts it on tap', async () => {
    const { getByTestId, getByText } = render(
      createElement(PlayDrawerHeatmapPanel, {
        heatmap: heatmap({ source: 'download' }),
        boardName: 'kilter',
        nudgeBoard: board,
      }),
    );
    expect(getByTestId('offline-nudge-card')).toBeTruthy();
    expect(offer.nudgeSurfaces).toContain('hold_heatmap');

    await act(async () => {
      fireEvent.click(getByText('mobile.offline.nudge.holdHeatmap.cta'));
    });
    expect(offer.confirmAndDownload).toHaveBeenCalledWith(board, { trigger: 'hold_heatmap', source: 'play_drawer' });
    expect(offer.accept).toHaveBeenCalledWith('download');
  });

  it('holds the offer back while the source is still resolving', () => {
    const { queryByTestId } = render(
      createElement(PlayDrawerHeatmapPanel, {
        heatmap: heatmap({ source: 'download', isResolving: true }),
        boardName: 'kilter',
        nudgeBoard: board,
      }),
    );
    expect(queryByTestId('offline-nudge-card')).toBeNull();
  });

  it('says why the board is not lighting up when the offer cannot show (another board)', () => {
    const { getByText, queryByTestId } = render(
      createElement(PlayDrawerHeatmapPanel, {
        heatmap: heatmap({ source: 'download' }),
        boardName: 'kilter',
        nudgeBoard: null,
      }),
    );
    expect(queryByTestId('offline-nudge-card')).toBeNull();
    expect(getByText('mobile.heatmap.needsDownload')).toBeTruthy();
  });

  it('shows the filter chip for a filtered search and toggles the whole board', () => {
    const toggleWholeBoard = vi.fn();
    const search = { filters: {} as never, boardFilters: {}, searchText: '' };
    const { getByText } = render(
      createElement(PlayDrawerHeatmapPanel, {
        heatmap: heatmap({ search, toggleWholeBoard }),
        boardName: 'kilter',
        nudgeBoard: board,
      }),
    );
    fireEvent.click(getByText('mobile.heatmap.filtered:V4–V6'));
    expect(toggleWholeBoard).toHaveBeenCalledTimes(1);
  });

  it('switches the colour mode and explains a filter the phone cannot follow', () => {
    const setMode = vi.fn();
    const { getByTestId, getByText } = render(
      createElement(PlayDrawerHeatmapPanel, {
        heatmap: heatmap({ setMode, filterUnsupported: true }),
        boardName: 'kilter',
        nudgeBoard: board,
      }),
    );
    fireEvent.click(getByTestId('mode-difficulty'));
    expect(setMode).toHaveBeenCalledWith('difficulty');
    expect(getByText('mobile.heatmap.filterUnsupported')).toBeTruthy();
  });
});
