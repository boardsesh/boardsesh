import { describe, expect, it, vi } from 'vitest';
import type { Climb } from '@boardsesh/queue';
import { createLoadedListFetchPage, MAX_LOADS_PER_TRACK_PAGE, type LoadedList } from '../loaded-list-pages';

function makeClimbs(prefix: string, count: number, from = 0): Climb[] {
  return Array.from({ length: count }, (_, index) => ({ uuid: `${prefix}-${from + index}` }) as unknown as Climb);
}

function loaded(climbs: Climb[], hasMore: boolean, loadedRows = climbs.length): LoadedList {
  return { climbs, hasMore, loadedRows };
}

const BOARD = { boardName: 'kilter', layoutId: 1, sizeId: 2, setIds: '3', angle: 40 };

function pageArgs(page: number, pageSize: number, signal = new AbortController().signal) {
  return { page, pageSize, board: BOARD, signal };
}

describe('createLoadedListFetchPage', () => {
  it('serves a page from the rows already loaded, without loading more', async () => {
    const loadMore = vi.fn();
    const fetchPage = createLoadedListFetchPage({ read: () => loaded(makeClimbs('row', 5), true), loadMore });

    const page = await fetchPage(pageArgs(1, 2));

    expect(page.climbs.map(({ uuid }) => uuid)).toEqual(['row-2', 'row-3']);
    expect(page.hasMore).toBe(true);
    expect(loadMore).not.toHaveBeenCalled();
  });

  it("loads the screen's next pages until the track page is covered", async () => {
    let list = loaded(makeClimbs('row', 2), true);
    const loadMore = vi.fn(async () => {
      const grown = list.climbs.length + 2;
      list = loaded(makeClimbs('row', grown), grown < 6);
      return list;
    });
    const fetchPage = createLoadedListFetchPage({ read: () => list, loadMore });

    const page = await fetchPage(pageArgs(1, 3));

    expect(loadMore).toHaveBeenCalledTimes(2);
    expect(page.climbs.map(({ uuid }) => uuid)).toEqual(['row-3', 'row-4', 'row-5']);
    expect(page.hasMore).toBe(false);
  });

  it('keeps going through a page of repeats, which adds rows and no climbs', async () => {
    let list = loaded(makeClimbs('row', 2), true, 2);
    const loadMore = vi
      .fn()
      .mockImplementationOnce(async () => {
        list = loaded(list.climbs, true, 4);
        return list;
      })
      .mockImplementationOnce(async () => {
        list = loaded(makeClimbs('row', 4), false, 6);
        return list;
      });
    const fetchPage = createLoadedListFetchPage({ read: () => list, loadMore });

    const page = await fetchPage(pageArgs(1, 2));

    expect(page.climbs.map(({ uuid }) => uuid)).toEqual(['row-2', 'row-3']);
  });

  it('stops when a load adds no rows, rather than asking forever', async () => {
    const stuck = loaded(makeClimbs('row', 2), true);
    const loadMore = vi.fn(async () => stuck);
    const fetchPage = createLoadedListFetchPage({ read: () => stuck, loadMore });

    const page = await fetchPage(pageArgs(1, 2));

    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(page.climbs).toEqual([]);
  });

  it('loads at most a bounded number of pages for one track page', async () => {
    let rows = 0;
    const loadMore = vi.fn(async () => {
      rows += 1;
      // Every page adds a row and never a climb: a pathological feed.
      return loaded([], true, rows);
    });
    const fetchPage = createLoadedListFetchPage({ read: () => loaded([], true, rows), loadMore });

    await fetchPage(pageArgs(0, 100));

    expect(loadMore).toHaveBeenCalledTimes(MAX_LOADS_PER_TRACK_PAGE);
  });

  it('ends the track once the screen shows another list', async () => {
    const loadMore = vi.fn();
    const fetchPage = createLoadedListFetchPage(
      { read: () => loaded(makeClimbs('row', 5), true), loadMore },
      () => false,
    );

    await expect(fetchPage(pageArgs(0, 2))).resolves.toEqual({ climbs: [], hasMore: false });
    expect(loadMore).not.toHaveBeenCalled();
  });

  it('rejects an aborted page as an abort', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchPage = createLoadedListFetchPage({ read: () => loaded([], true), loadMore: vi.fn() });

    await expect(fetchPage(pageArgs(0, 2, controller.signal))).rejects.toMatchObject({ name: 'AbortError' });
  });
});
