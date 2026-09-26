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
    t: (key: string, values?: Record<string, string | number>) =>
      values?.summary !== undefined
        ? `${key}:${values.summary}`
        : values?.formattedCount !== undefined
          ? `${key}:${values.formattedCount}`
          : key,
  }),
}));
vi.mock('../../../Text', () => ({
  Text: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('span', { 'data-testid': testID }, children),
}));
vi.mock('../../../Icon', () => ({ Icon: () => null }));
vi.mock('../../../SegmentedControl', () => ({
  SegmentedControl: ({ onSelect }: { onSelect: (key: string) => void }) =>
    createElement('button', { 'data-testid': 'mode-grade', onClick: () => onSelect('grade') }, 'modes'),
}));
const firstRun = vi.hoisted(() => ({ stored: 0 as number | null, writes: [] as unknown[] }));
vi.mock('../../../../lib/preference-store', () => ({
  getPreference: async () => firstRun.stored,
  setPreference: async (_key: string, value: unknown) => {
    firstRun.writes.push(value);
  },
}));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({
    colorScheme: 'dark',
    systemColors: { secondaryLabel: '#888', tertiaryLabel: '#999', separator: '#ccc' },
    brandColors: { primary: '#000' },
    heatRamp: ['#4C1D95', '#6D28D9', '#8B5CF6', '#C4B5FD', '#F5F3FF'],
  }),
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

import { DEFAULT_FILTERS } from '../../../../lib/climb-filter-types';
import { PlayDrawerHeatmapPanel } from '../PlayDrawerHeatmapPanel';
import type { PlayDrawerHeatmap } from '../use-play-drawer-heatmap';

const board = { boardType: 'kilter', layoutId: 1, sizeId: 10, name: 'Home Kilter' } as UserBoard;

function heatmap(overrides: Partial<PlayDrawerHeatmap> = {}): PlayDrawerHeatmap {
  return {
    enabled: true,
    toggle: vi.fn(),
    mode: 'climbs',
    setMode: vi.fn(),
    search: null,
    wholeBoard: false,
    toggleWholeBoard: vi.fn(),
    source: 'local',
    isResolving: false,
    filterUnsupported: false,
    holdPicksSkipped: false,
    isBusy: false,
    isError: false,
    isEmpty: false,
    isUnavailable: false,
    climbCount: null,
    legend: { kind: 'count', edgeValues: [3, 8, 20, 55, 140], total: 400 },
    overlay: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  offer.nudgeVisible = true;
  offer.nudgeSurfaces = [];
  firstRun.stored = 3;
  firstRun.writes = [];
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

  it('offers the download in one line for a board that is not on the phone, and starts it on tap', async () => {
    const { getByTestId, getByText } = render(
      createElement(PlayDrawerHeatmapPanel, {
        heatmap: heatmap({ source: 'download' }),
        boardName: 'kilter',
        nudgeBoard: board,
      }),
    );
    expect(getByTestId('hold-heatmap-download-line')).toBeTruthy();
    expect(getByText('mobile.heatmap.downloadLine')).toBeTruthy();
    expect(offer.nudgeSurfaces).toContain('hold_heatmap');

    await act(async () => {
      fireEvent.click(getByText('mobile.heatmap.download'));
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
    expect(queryByTestId('hold-heatmap-download-line')).toBeNull();
  });

  it('says why the board is not lighting up when the offer cannot show (another board)', () => {
    const { getByText, queryByText } = render(
      createElement(PlayDrawerHeatmapPanel, {
        heatmap: heatmap({ source: 'download' }),
        boardName: 'kilter',
        nudgeBoard: null,
      }),
    );
    expect(queryByText('mobile.heatmap.download')).toBeNull();
    expect(getByText('mobile.heatmap.needsDownload')).toBeTruthy();
  });

  it('shows the scope chip (no "Filtered" prefix) for a filtered search and toggles the whole board', () => {
    const toggleWholeBoard = vi.fn();
    const search = { filters: DEFAULT_FILTERS, boardFilters: {}, searchText: 'crimp' };
    const { getByText } = render(
      createElement(PlayDrawerHeatmapPanel, {
        heatmap: heatmap({ search, toggleWholeBoard }),
        boardName: 'kilter',
        nudgeBoard: board,
      }),
    );
    fireEvent.click(getByText('V4–V6'));
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
    fireEvent.click(getByTestId('mode-grade'));
    expect(setMode).toHaveBeenCalledWith('grade');
    expect(getByText('mobile.heatmap.filterUnsupported')).toBeTruthy();
  });

  it('names a holds-only search by its board filters', () => {
    const search = {
      filters: DEFAULT_FILTERS,
      boardFilters: { holdsFilter: { hold_1: { ANY: 'include' as const } } },
      searchText: '',
    };
    const { getByText } = render(
      createElement(PlayDrawerHeatmapPanel, { heatmap: heatmap({ search }), boardName: 'kilter', nudgeBoard: board }),
    );
    expect(getByText('mobile.holdFilter.summaryCount')).toBeTruthy();
  });

  it('says the heatmap is unavailable, not that no climbs match, when the phone could not answer', () => {
    const { getByText, queryByText } = render(
      createElement(PlayDrawerHeatmapPanel, {
        heatmap: heatmap({ isUnavailable: true }),
        boardName: 'kilter',
        nudgeBoard: board,
      }),
    );
    expect(getByText('mobile.heatmap.unavailable')).toBeTruthy();
    expect(queryByText('mobile.heatmap.empty')).toBeNull();
  });

  it('says when the hold picks were skipped offline', () => {
    const search = { filters: DEFAULT_FILTERS, boardFilters: {}, searchText: 'crimp' };
    const { getByText } = render(
      createElement(PlayDrawerHeatmapPanel, {
        heatmap: heatmap({ search, holdPicksSkipped: true }),
        boardName: 'kilter',
        nudgeBoard: board,
      }),
    );
    expect(getByText('mobile.heatmap.holdPicksSkipped:V4–V6')).toBeTruthy();
  });

  it('shows the legend ends, the real counts at the bucket edges and the scope count', () => {
    const { getByText } = render(
      createElement(PlayDrawerHeatmapPanel, {
        heatmap: heatmap({ climbCount: 18240 }),
        boardName: 'kilter',
        nudgeBoard: board,
      }),
    );
    expect(getByText('mobile.heatmap.legend.fewClimbs')).toBeTruthy();
    expect(getByText('mobile.heatmap.legend.manyClimbs')).toBeTruthy();
    expect(getByText('140')).toBeTruthy();
    expect(getByText('mobile.heatmap.climbCount:18k')).toBeTruthy();
  });

  it('names the grade ends in grade mode', () => {
    const { getByText } = render(
      createElement(PlayDrawerHeatmapPanel, {
        heatmap: heatmap({
          mode: 'grade',
          legend: { kind: 'grade', lowVNumber: 2, highVNumber: 8, swatches: ['#a', '#b', '#c', '#d', '#e'] },
        }),
        boardName: 'kilter',
        nudgeBoard: board,
      }),
    );
    expect(getByText('mobile.heatmap.legend.easier')).toBeTruthy();
    expect(getByText('mobile.heatmap.legend.harder')).toBeTruthy();
  });

  it('explains the colours on the first three views only, and counts the view', async () => {
    firstRun.stored = 1;
    const { findByTestId } = render(
      createElement(PlayDrawerHeatmapPanel, { heatmap: heatmap(), boardName: 'kilter', nudgeBoard: board }),
    );
    expect((await findByTestId('play-drawer-heatmap-caption')).textContent).toBe('mobile.heatmap.firstRun.climbsDark');
    expect(firstRun.writes).toEqual([2]);
  });

  it('stays quiet after the third view', async () => {
    firstRun.stored = 3;
    const { queryByTestId } = render(
      createElement(PlayDrawerHeatmapPanel, { heatmap: heatmap(), boardName: 'kilter', nudgeBoard: board }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(queryByTestId('play-drawer-heatmap-caption')).toBeNull();
    expect(firstRun.writes).toEqual([]);
  });
});
