// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Climb as SchemaClimb } from '@boardsesh/shared-schema';
import type { Climb } from '@boardsesh/queue';
import type { UsePlaylistActivationOptions } from '../use-playlist-activation';
import { useBoardListActivation, type BoardListRow } from '../use-board-list-activation';
import { setSetting } from '../../../settings/hooks';

type ActiveBoard = { boardType: string; layoutId: number; sizeId: number; setIds: string; angle: number } | null;

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  options: undefined as UsePlaylistActivationOptions | undefined,
  isSharedSession: false,
  activeBoard: { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 } as ActiveBoard,
}));

// The activation hook has its own suite. Here we check what this list hands it.
vi.mock('../use-playlist-activation', () => ({
  usePlaylistActivation: (options: UsePlaylistActivationOptions) => {
    mocks.options = options;
    return { activate: mocks.activate, addToQueue: { isAppending: false } };
  },
}));
vi.mock('../../../providers/queue-provider', () => ({ useIsSharedSession: () => mocks.isSharedSession }));
vi.mock('../../graphql/use-active-board', () => ({ useActiveBoard: () => ({ data: mocks.activeBoard }) }));

type Row = { id: string; climbUuid: string | null; angle: number; board: BoardListRow['board'] };

const KILTER_ROW_BOARD = { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 25 };
const TENSION_ROW_BOARD = { boardName: 'tension', layoutId: 9, sizeId: 3, setIds: '4', angle: 30 };

function makeRow(id: string, climbUuid: string | null, angle = 40, board: Row['board'] = KILTER_ROW_BOARD): Row {
  return { id, climbUuid, angle, board };
}

const describeRow = (row: Row): BoardListRow => ({
  climb: row.climbUuid ? ({ uuid: row.climbUuid, angle: row.angle, name: row.id } as unknown as SchemaClimb) : null,
  board: row.board,
});

function options(): UsePlaylistActivationOptions {
  if (!mocks.options) throw new Error('usePlaylistActivation was not called');
  return mocks.options;
}

function viewOnlyBoardFor(climb: Climb) {
  const resolver = options().viewOnlyBoard;
  if (typeof resolver !== 'function') throw new Error('expected a per-climb resolver');
  return resolver(climb);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.options = undefined;
  mocks.isSharedSession = false;
  mocks.activeBoard = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 };
  setSetting('lightOnClimbTap', true);
});

describe('useBoardListActivation', () => {
  it('plays from the rows, one entry per climb, with the rows as the whole list', () => {
    const rows = [makeRow('r1', 'climb-a'), makeRow('r2', 'climb-b'), makeRow('r3', 'climb-a', 25)];
    renderHook(() => useBoardListActivation({ sourceId: 'logbook:me', label: 'Logbook', rows, describeRow }));

    expect(options()).toMatchObject({
      sourceId: 'logbook:me',
      label: 'Logbook',
      loadedRowsAreTheList: true,
      hasMoreRows: false,
      previewOnly: false,
    });
    expect(options().allClimbs.map(({ uuid }) => uuid)).toEqual(['climb-a', 'climb-b']);
  });

  it('previews in a crew', () => {
    mocks.isSharedSession = true;
    renderHook(() => useBoardListActivation({ sourceId: 's', label: 'l', rows: [], describeRow }));

    expect(options().previewOnly).toBe(true);
  });

  it('opens the tapped row on its own board and angle', () => {
    const row = makeRow('r1', 'climb-a', 25);
    const { result } = renderHook(() =>
      useBoardListActivation({ sourceId: 's', label: 'l', rows: [row], describeRow }),
    );

    result.current(row);

    const tappedClimb = mocks.activate.mock.calls[0][0] as Climb;
    expect(tappedClimb).toMatchObject({ uuid: 'climb-a', angle: 25 });
    expect(options().drawerBoardFor?.(tappedClimb)).toEqual(KILTER_ROW_BOARD);
    // Same board model as the active board: it plays here, not as a wrong-board preview.
    expect(viewOnlyBoardFor(tappedClimb)).toBeNull();
  });

  it('previews a row from another board model on that board', () => {
    const row = makeRow('r1', 'climb-a', 30, TENSION_ROW_BOARD);
    const { result } = renderHook(() =>
      useBoardListActivation({ sourceId: 's', label: 'l', rows: [row], describeRow }),
    );

    result.current(row);

    expect(viewOnlyBoardFor(mocks.activate.mock.calls[0][0] as Climb)).toEqual(TENSION_ROW_BOARD);
  });

  it('previews on the row board when no board is picked', () => {
    mocks.activeBoard = null;
    const row = makeRow('r1', 'climb-a', 25);
    const { result } = renderHook(() =>
      useBoardListActivation({ sourceId: 's', label: 'l', rows: [row], describeRow }),
    );

    result.current(row);

    expect(viewOnlyBoardFor(mocks.activate.mock.calls[0][0] as Climb)).toEqual(KILTER_ROW_BOARD);
  });

  it('plays a one-climb list for a row that is not in the rows (a session card)', () => {
    const row = makeRow('card', 'climb-z', 35);
    const { result } = renderHook(() => useBoardListActivation({ sourceId: 's', label: 'l', rows: [], describeRow }));

    result.current(row);

    const tappedClimb = mocks.activate.mock.calls[0][0] as Climb;
    expect(tappedClimb).toMatchObject({ uuid: 'climb-z' });
    expect(options().drawerBoardFor?.(tappedClimb)).toEqual(KILTER_ROW_BOARD);
  });

  it.each([
    ['solo, lighting on', false, true, false],
    ['solo, lighting off', false, false, true],
    ['in a crew', true, true, true],
  ] as const)('sends a row with nothing to draw to its own route (%s)', (_case, shared, lightOnTap, preview) => {
    mocks.isSharedSession = shared;
    setSetting('lightOnClimbTap', lightOnTap);
    const openFallback = vi.fn();
    const row = makeRow('r1', null);
    const { result } = renderHook(() =>
      useBoardListActivation({ sourceId: 's', label: 'l', rows: [row], describeRow, openFallback }),
    );

    result.current(row);

    expect(openFallback).toHaveBeenCalledWith(row, { preview });
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it('keeps its tap handler as pages land, so memoised rows hold', () => {
    let rows = [makeRow('r1', 'climb-a')];
    const { result, rerender } = renderHook(() =>
      useBoardListActivation({ sourceId: 's', label: 'l', rows, describeRow }),
    );
    const before = result.current;

    rows = [...rows, makeRow('r2', 'climb-b')];
    rerender();

    expect(result.current).toBe(before);
  });

  it('pages the track on through the screen query', async () => {
    const firstRows = [makeRow('r1', 'climb-a')];
    const loadMore = vi.fn(async () => ({ rows: [...firstRows, makeRow('r2', 'climb-b')], hasMore: false }));
    renderHook(() =>
      useBoardListActivation({ sourceId: 's', label: 'l', rows: firstRows, describeRow, hasMore: true, loadMore }),
    );
    expect(options().hasMoreRows).toBe(true);

    const fetchPage = options().snapshotFetchPage?.() ?? options().fetchPage;
    const page = await fetchPage({
      page: 0,
      pageSize: 100,
      board: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 },
      signal: new AbortController().signal,
    });

    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(page).toEqual({
      climbs: [expect.objectContaining({ uuid: 'climb-a' }), expect.objectContaining({ uuid: 'climb-b' })],
      hasMore: false,
    });
  });

  it('stops a track paging once the screen shows another list', async () => {
    let listKey = 'filters-a';
    const loadMore = vi.fn();
    const { rerender } = renderHook(() =>
      useBoardListActivation({
        sourceId: 's',
        label: 'l',
        rows: [makeRow('r1', 'climb-a')],
        describeRow,
        hasMore: true,
        loadMore,
        listKey,
      }),
    );
    const trackFetchPage = options().snapshotFetchPage?.();
    if (!trackFetchPage) throw new Error('expected a snapshot fetcher');

    listKey = 'filters-b';
    rerender();
    const page = await trackFetchPage({
      page: 0,
      pageSize: 100,
      board: { boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,2', angle: 40 },
      signal: new AbortController().signal,
    });

    expect(page).toEqual({ climbs: [], hasMore: false });
    expect(loadMore).not.toHaveBeenCalled();
  });
});
