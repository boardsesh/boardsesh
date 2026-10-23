// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaylistSortOption } from '@boardsesh/climb-filters';
import type { PinnedChipsStore } from '../../lib/pinned-chips-store';
import { PLAYLIST_PINNABLE_CHIP_KINDS, type PlaylistPinnableChipKind } from '../../lib/playlist-pinnable-chips';
import { PLAYLIST_FILTER_DEFAULTS } from '../../lib/playlists/playlist-view';
import { playlistSortModel, type PlaylistSessionSort } from '../../lib/playlists/playlist-sort-model';

// One `t` for every render, as react-i18next hands out.
const translation = vi.hoisted(() => ({
  t: (key: string, options?: { name?: string; count?: number }) =>
    options?.name !== undefined ? `${key}:${options.name}` : key,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => translation }));
const authMock = vi.hoisted(() => ({ isAuthenticated: true }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: () => authMock }));
vi.mock('../../lib/graphql/hooks', () => ({
  useGrades: () => ({
    data: [
      { difficultyId: 10, name: '6a/V3' },
      { difficultyId: 12, name: '6b/V4' },
    ],
  }),
}));
vi.mock('../use-grade-format', () => ({
  useGradeFormat: () => ({ gradeFormat: 'v-grade', formatGradeByDifficultyId: () => null }),
}));
vi.mock('../use-last-used-grade', () => ({ useLastUsedGrade: () => ({ lastUsedGrade: undefined }) }));
const layoutMock = vi.hoisted(() => ({ isPad: false, widthClass: 'compact' }));
vi.mock('../use-device-layout', () => ({ useDeviceLayout: () => layoutMock }));
vi.mock('../../components/grade', () => ({ GradeRangeRail: () => null }));
vi.mock('../../lib/spray/spray-wall-registry', () => ({ SPRAY_BOARD_NAME: 'spray' }));

import { useClimbFilterSession, type UseClimbFilterSessionOptions } from '../use-climb-filter-session';

// A pin store with fixed pins and stable functions, as the real module-level store has.
const pinState = vi.hoisted(() => ({ pinned: [] as string[], togglePin: vi.fn() }));
const isPinned = (kind: PlaylistPinnableChipKind) => pinState.pinned.includes(kind);
const fakePinStore = {
  storageKey: 'test',
  usePinnedChips: () => ({
    pinned: pinState.pinned as PlaylistPinnableChipKind[],
    loaded: true,
    isPinned,
    togglePin: pinState.togglePin,
  }),
  load: vi.fn(),
  set: vi.fn(),
  toggle: vi.fn(),
  resetForTests: vi.fn(),
} as unknown as PinnedChipsStore<PlaylistPinnableChipKind>;

const BOARD = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };
const SECTIONS = { recent: false, drafts: false };
const PLAIN_SORT: PlaylistSessionSort = { sortBy: 'position', sortOrder: 'asc' };

type Options = UseClimbFilterSessionOptions<PlaylistSortOption, PlaylistPinnableChipKind>;

function renderSession(overrides: Partial<Options> = {}) {
  const onSortCommit = vi.fn();
  const initialProps: Options = {
    scopeKey: 'playlist:p-1|kilter|true',
    boardConfig: BOARD,
    gradeBoardName: 'kilter',
    defaultFilters: PLAYLIST_FILTER_DEFAULTS,
    sortModel: playlistSortModel,
    initialSort: PLAIN_SORT,
    onSortCommit,
    pinStore: fakePinStore,
    pinnable: PLAYLIST_PINNABLE_CHIP_KINDS,
    sections: SECTIONS,
    activeBoardAvailable: true,
    activeBoardOnlyChips: ['progress', 'beta', 'boardFit'],
    liveCount: null,
    disabled: false,
    ...overrides,
  };
  const rendered = renderHook((props: Options) => useClimbFilterSession(props), { initialProps });
  return { ...rendered, onSortCommit, initialProps };
}

beforeEach(() => {
  authMock.isAuthenticated = true;
  layoutMock.isPad = false;
  layoutMock.widthClass = 'compact';
  pinState.pinned = ['grade', 'progress', 'sort'];
  pinState.togglePin.mockClear();
  vi.useFakeTimers();
});

afterEach(() => vi.useRealTimers());

describe('useClimbFilterSession', () => {
  it('keeps chipRowProps and the actions the same object across unrelated renders', () => {
    const { result, rerender, initialProps } = renderSession();
    const { chipRowProps } = result.current.state;
    const { actions } = result.current;

    // A page load (the live count) and a fresh but equal options object.
    rerender({ ...initialProps, liveCount: 117 });
    rerender({ ...initialProps, liveCount: 117 });

    expect(result.current.state.chipRowProps).toBe(chipRowProps);
    expect(result.current.actions).toBe(actions);
  });

  it('opens on the remembered sort and rests the chip on "Playlist order"', () => {
    const { result } = renderSession({ initialSort: { sortBy: 'difficulty', sortOrder: 'desc' } });
    expect(result.current.state.querySelection.sort).toEqual({ sortBy: 'difficulty', sortOrder: 'desc' });
    expect(result.current.state.chipRowProps.sortControl).toMatchObject({
      label: 'mobile.filter.sortDirection.difficulty.desc',
      active: true,
      selected: 'difficulty',
    });

    act(() => result.current.state.chipRowProps.sortControl?.onSelect('position'));
    expect(result.current.state.chipRowProps.sortControl).toMatchObject({
      label: 'mobile.filter.sort.position',
      active: false,
    });
  });

  it('counts the name and "fits my board" but never the sort', () => {
    const { result } = renderSession();
    act(() => result.current.state.chipRowProps.sortControl?.onSelect('difficulty'));
    expect(result.current.state.chipRowProps.sortControl?.active).toBe(true);
    expect(result.current.state.activeFilterCount).toBe(0);

    act(() => result.current.state.chipRowProps.boardFit?.onToggle());
    expect(result.current.state.activeFilterCount).toBe(1);

    act(() => result.current.actions.openFilters());
    act(() => result.current.state.sheetProps?.onNameChange('crimp'));
    expect(result.current.state.activeFilterCount).toBe(1);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.state.querySelection.name).toBe('crimp');
    expect(result.current.state.activeFilterCount).toBe(2);
  });

  it('applies a cleared name at once, without the debounce', () => {
    const { result } = renderSession();
    act(() => result.current.actions.openFilters());
    act(() => result.current.state.sheetProps?.onNameChange('crimp'));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    act(() => result.current.state.sheetProps?.onNameChange(''));
    expect(result.current.state.querySelection.name).toBe('');
  });

  it('drops the signed-in filters when signed out', () => {
    const { result, rerender, initialProps } = renderSession();
    act(() => result.current.state.chipRowProps.onChangeProgress('unsent'));
    expect(result.current.state.querySelection.filters.hideCompleted).toBe(true);
    expect(result.current.state.chipRowProps.canFilterProgress).toBe(true);

    authMock.isAuthenticated = false;
    rerender({ ...initialProps, scopeKey: 'playlist:p-1|kilter|false' });

    expect(result.current.state.querySelection.filters.hideCompleted).toBeUndefined();
    expect(result.current.state.chipRowProps.canFilterProgress).toBe(false);
    expect(result.current.state.activeFilterCount).toBe(0);
  });

  it('remembers a picked sort, never a paused one, and forgets it on Reset', () => {
    const { result, onSortCommit } = renderSession();
    act(() => result.current.state.chipRowProps.sortControl?.onSelect('quality'));
    expect(onSortCommit).toHaveBeenCalledTimes(1);
    expect(onSortCommit).toHaveBeenLastCalledWith({ sortBy: 'quality', sortOrder: 'desc' });

    act(() => result.current.actions.pauseView());
    expect(result.current.state.querySelection.sort).toEqual(PLAIN_SORT);
    act(() => result.current.actions.resumeView());
    expect(result.current.state.querySelection.sort).toEqual({ sortBy: 'quality', sortOrder: 'desc' });
    expect(onSortCommit).toHaveBeenCalledTimes(1);

    act(() => result.current.actions.resetToDefault());
    expect(onSortCommit).toHaveBeenCalledTimes(2);
    expect(onSortCommit).toHaveBeenLastCalledWith(PLAIN_SORT);
  });

  it('keeps Filters shut while disabled', () => {
    const { result, rerender, initialProps } = renderSession({ disabled: true });
    act(() => result.current.actions.openFilters());
    expect(result.current.state.sheetProps).toBeNull();

    rerender({ ...initialProps, disabled: false });
    act(() => result.current.actions.openFilters());
    expect(result.current.state.sheetProps).not.toBeNull();

    // Edit mode starting with the sheet open shuts it.
    rerender({ ...initialProps, disabled: true });
    expect(result.current.state.sheetProps).toBeNull();
  });

  it('hands the sheet the playlist seams: defaults, pins, sections, live count and its own Reset', () => {
    const { result, rerender, initialProps } = renderSession();
    act(() => result.current.actions.openFilters());
    rerender({ ...initialProps, liveCount: 12 });
    const sheetProps = result.current.state.sheetProps;
    expect(sheetProps?.defaultFilters).toBe(PLAYLIST_FILTER_DEFAULTS);
    expect(sheetProps?.sections).toBe(SECTIONS);
    expect(sheetProps?.liveCount).toEqual({ count: 12 });
    expect(sheetProps?.boardFit).toEqual({ value: false, onChange: expect.any(Function) });
    expect(sheetProps?.pins?.isPinned('grade')).toBe(true);
    expect(sheetProps?.pins?.isPinned('recent')).toBe(false);
    sheetProps?.pins?.togglePin('recent');
    expect(pinState.togglePin).not.toHaveBeenCalled();
    sheetProps?.pins?.togglePin('boardFit');
    expect(pinState.togglePin).toHaveBeenCalledWith('boardFit');
  });

  it('words the sheet directions, the opening one first, and hides them for one-way keys', () => {
    const { result } = renderSession();
    act(() => result.current.actions.openFilters());
    expect(result.current.state.sheetProps?.sortControl?.orderOptions).toBeNull();

    act(() => result.current.state.sheetProps?.sortControl?.onSelect('difficulty'));
    expect(result.current.state.sheetProps?.sortControl?.orderOptions).toEqual([
      { key: 'asc', label: 'mobile.filter.sortDirection.difficulty.asc' },
      { key: 'desc', label: 'mobile.filter.sortDirection.difficulty.desc' },
    ]);
    act(() => result.current.state.sheetProps?.sortControl?.onOrderChange('desc'));
    expect(result.current.state.sheetProps?.sortControl).toMatchObject({ selected: 'difficulty', order: 'desc' });

    act(() => result.current.state.sheetProps?.sortControl?.onSelect('added'));
    expect(result.current.state.sheetProps?.sortControl?.orderOptions?.[0]?.key).toBe('desc');

    act(() => result.current.state.sheetProps?.sortControl?.onSelect('random'));
    act(() => {
      vi.advanceTimersByTime(250);
    });
    const seed = result.current.state.querySelection.sort.sortSeed;
    expect(seed).toMatch(/^\d+$/);
    expect(result.current.state.sheetProps?.sortControl?.showReshuffle).toBe(true);
    expect(result.current.state.sheetProps?.sortControl?.orderOptions).toBeNull();
    act(() => result.current.state.sheetProps?.sortControl?.onReshuffle());
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current.state.querySelection.sort.sortSeed).not.toBe(seed);
  });

  it('lists a token for each filter no pinned chip shows, the name first', () => {
    pinState.pinned = ['grade'];
    const { result } = renderSession();
    act(() => result.current.state.chipRowProps.onChangeRating(3));
    act(() => result.current.state.chipRowProps.boardFit?.onToggle());
    act(() => result.current.state.chipRowProps.sortControl?.onSelect('name'));
    act(() => result.current.actions.openFilters());
    act(() => result.current.state.sheetProps?.onNameChange('crimp'));
    act(() => {
      vi.advanceTimersByTime(300);
    });

    const tokens = result.current.state.tokens;
    expect(tokens.map((token) => token.key)).toEqual(['name', 'minRating', 'boardFit', 'sort']);
    expect(tokens[0]?.label).toBe('mobile.filter.nameToken:crimp');
    expect(tokens.at(-1)?.label).toBe('mobile.filter.sortDirection.name.asc');

    act(() => tokens.at(-1)?.clear());
    expect(result.current.state.chipRowProps.sortControl).toMatchObject({ selected: 'position', active: false });
  });

  it('shows no climb-type token for a playlist resting on both types', () => {
    pinState.pinned = [];
    const { result } = renderSession();
    expect(result.current.state.tokens).toEqual([]);
    expect(result.current.state.chipRowProps.climbType).toBe('both');
    expect(result.current.state.chipRowProps.defaultClimbType).toBe('both');
    act(() => result.current.state.chipRowProps.onChangeClimbType('boulders'));
    expect(result.current.state.tokens.map((token) => token.key)).toEqual(['climbType']);
  });

  it('Clear filters keeps the sort', () => {
    const { result } = renderSession();
    act(() => result.current.state.chipRowProps.sortControl?.onSelect('difficulty'));
    act(() => result.current.state.chipRowProps.onChangeRating(4));
    act(() => result.current.actions.clearFilters());
    expect(result.current.state.querySelection.filters).toBe(PLAYLIST_FILTER_DEFAULTS);
    expect(result.current.state.querySelection.sort.sortBy).toBe('difficulty');
  });

  it('opens the grade rail locally, never through a global setting', () => {
    const { result } = renderSession();
    expect(result.current.state.gradeRail).toBeNull();
    act(() => result.current.state.chipRowProps.onOpenGrade());
    expect(result.current.state.gradeRail).not.toBeNull();
    expect(result.current.state.chipRowProps.gradeRailOpen).toBe(true);
    act(() => result.current.state.chipRowProps.onCloseGrade());
    expect(result.current.state.gradeRail).toBeNull();
  });

  it('presents the grade rail as a popover on a regular-width iPad', () => {
    layoutMock.isPad = true;
    layoutMock.widthClass = 'regular';
    const { result } = renderSession();
    act(() => result.current.state.chipRowProps.onOpenGrade());
    expect(result.current.state.gradeRail).toBeNull();
    expect(result.current.state.chipRowProps.gradePopoverContent).toBeDefined();
    expect(result.current.state.chipRowProps.gradeRailOpen).toBe(true);
  });

  it('offers no "fits my board" without an active board', () => {
    const { result } = renderSession({ activeBoardAvailable: false, boardConfig: null });
    expect(result.current.state.chipRowProps.boardFit).toBeUndefined();
    act(() => result.current.actions.openFilters());
    expect(result.current.state.sheetProps?.boardFit).toBeUndefined();
  });

  it('drops the active-board-only chips and filters while there is no active board', () => {
    pinState.pinned = ['grade', 'progress', 'beta', 'sort'];
    const { result, rerender, initialProps } = renderSession();
    act(() => result.current.state.chipRowProps.onChangeProgress('untried'));
    act(() => result.current.state.chipRowProps.onToggleBeta());
    act(() => result.current.state.chipRowProps.onChangeRating(3));
    expect(result.current.state.activeFilterCount).toBe(3);

    // The board goes away: its filters would match nothing, so they stop filtering.
    rerender({ ...initialProps, activeBoardAvailable: false, boardConfig: null });
    expect(result.current.state.chipRowProps.pinnedChips).toEqual(['grade', 'sort']);
    expect(result.current.state.querySelection.filters.showOnlyAttempted).toBeUndefined();
    expect(result.current.state.querySelection.filters.onlyWithBetaVideos).toBeUndefined();
    expect(result.current.state.querySelection.filters.minRating).toBe(3);
    expect(result.current.state.activeFilterCount).toBe(1);
    expect(result.current.state.tokens).toEqual([expect.objectContaining({ key: 'minRating' })]);

    // Back on a board, the chips and their picks return.
    rerender(initialProps);
    expect(result.current.state.chipRowProps.pinnedChips).toEqual(['grade', 'progress', 'beta', 'sort']);
    expect(result.current.state.activeFilterCount).toBe(3);
  });

  it('holds a sort picked in the open sheet with the filters, so one settled change is one query', () => {
    const { result } = renderSession();
    act(() => result.current.actions.openFilters());
    act(() => result.current.state.sheetProps?.onSelectionChange({ ...PLAYLIST_FILTER_DEFAULTS, minRating: 3 }, {}));
    act(() => result.current.state.sheetProps?.sortControl?.onSelect('difficulty'));

    expect(result.current.state.chipRowProps.sortControl?.selected).toBe('difficulty');
    expect(result.current.state.querySelection.sort.sortBy).toBe('position');
    expect(result.current.state.querySelection.filters.minRating).toBeUndefined();

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current.state.querySelection.sort.sortBy).toBe('difficulty');
    expect(result.current.state.querySelection.filters.minRating).toBe(3);
  });

  it('applies a chip sort at once, with the sheet shut', () => {
    const { result } = renderSession();
    act(() => result.current.state.chipRowProps.sortControl?.onSelect('difficulty'));
    expect(result.current.state.querySelection.sort.sortBy).toBe('difficulty');
  });

  it('keeps the direction when the ticked sort is picked again', () => {
    const { result } = renderSession({ initialSort: { sortBy: 'difficulty', sortOrder: 'desc' } });
    act(() => result.current.state.chipRowProps.sortControl?.onSelect('difficulty'));
    expect(result.current.state.querySelection.sort).toEqual({ sortBy: 'difficulty', sortOrder: 'desc' });
  });
});
