// Pages a swipe track over a list the screen already pages itself (issue
// #6665): the logbook, a profile's climbs. The screen's own query holds the
// list, in its own page size, so the track reads it through that query rather
// than asking the server for the same rows a second way.
//
// A track walks the list by position (`createLoadedListTrackLoader`): each
// request serves the climbs from the exact place the last one stopped, so a
// request that comes back short skips nothing, and each request loads at most
// a few of the screen's pages. A logbook holds a climb once per day it was
// climbed, so a project-heavy one can take dozens of pages to show 100 new
// climbs; a track never loads them all in one go. That only happens as the
// climber swipes near the end of the track (see `use-track-paging.ts`), never
// on a tap.
//
// `createLoadedListFetchPage` is the same list in whole pages, for the hook's
// `fetchPage`: a page there must be whole, because the next one starts at the
// next page boundary.

import type { Climb } from '@boardsesh/queue';
import type { UsePlaylistActivationOptions } from './use-playlist-activation';
import type { HttpPageConsumer } from '../graphql/use-http-query';

/** A list as it is loaded right now. */
export type LoadedList = {
  /** The list's climbs from its first row, in order, one per climb. */
  climbs: Climb[];
  /** The query has more rows past these. */
  hasMore: boolean;
  /**
   * How many rows the query has loaded. Not `climbs.length`: a page of a
   * logbook can be all repeats of climbs already in the list, which adds rows
   * and no climbs, and the list has still moved on.
   */
  loadedRows: number;
  /** Original causes for rows not yet admitted by a track publication. */
  receipt?: HttpPageConsumer;
};

export type LoadedListProgress = LoadedList | { status: 'no-progress' | 'held' };

export type LoadedListSource = {
  read: () => LoadedList;
  /**
   * Load the query's next page; resolves with the list as loaded after it.
   * Rejects when the page fails, which ends the track where it is.
   */
  loadMore: () => Promise<LoadedListProgress>;
  /** Present only for an adopted original source, independent of its screen. */
  assertCurrent?: () => void;
  dispose?: () => void;
  /** Scoped ambiguity holds; native retains its two-load terminal rule. */
  holdOnNoProgress?: boolean;
};

const heldListLoads = new WeakSet<object>();
export function holdLoadedList(): Error {
  const error = new Error('The original list is unavailable');
  error.name = 'AbortError';
  heldListLoads.add(error);
  return error;
}
export function isLoadedListHeld(error: unknown): boolean {
  return error !== null && typeof error === 'object' && heldListLoads.has(error);
}

/** Aggregates references, never substitutes a newer operation for a cause. */
export function combineLoadedListReceipts(
  receipts: readonly HttpPageConsumer[],
  assertSource?: () => void,
): HttpPageConsumer | undefined {
  if (!receipts.length && !assertSource) return undefined;
  const captured = [...receipts];
  let released = false;
  const assertCurrent = () => {
    try {
      assertSource?.();
      for (const receipt of captured) receipt.assertCurrent();
      assertSource?.();
    } catch {
      throw holdLoadedList();
    }
  };
  return Object.freeze({
    assertCurrent,
    retain() {
      if (released) throw holdLoadedList();
      assertCurrent();
      return combineLoadedListReceipts(
        captured.map((receipt) => receipt.retain()),
        assertSource,
      )!;
    },
    acknowledge() {
      assertCurrent();
      for (const receipt of captured) receipt.acknowledge();
    },
    release() {
      if (released) return;
      released = true;
      for (const receipt of captured) receipt.release();
    },
  });
}

type FetchPage = UsePlaylistActivationOptions['fetchPage'];

function abortError(): Error {
  const error = new Error('Loading the list was cancelled');
  error.name = 'AbortError';
  return error;
}

/**
 * How many of the screen's pages one track request may load. Five 20-row
 * logbook pages, about one track page of a list without repeats. Fewer new
 * climbs than that just make a shorter request; the next one carries on from
 * where it stopped.
 */
export const MAX_LIST_LOADS_PER_TRACK_REQUEST = 5;

/** Climbs `offset` onwards of a loaded list, and where the next request starts. */
export type LoadedListTrackLoad = {
  climbs: Climb[];
  /** The list position after the last climb served, or null at the list's end. */
  nextOffset: number | null;
  receipt?: HttpPageConsumer;
};

export type LoadedListTrackLoader = (args: {
  /** The list position to start at: the first climb not yet served. */
  offset: number;
  /** The most climbs to serve. */
  count: number;
  signal: AbortSignal;
}) => Promise<LoadedListTrackLoad>;

/**
 * A track's loader over a list its screen pages, by position. `isSameList`
 * says whether the screen still shows the list the track was built from: a
 * climber who changes the logbook's filters after the tap gets a track that
 * ends where it is, rather than one that carries on into the other list.
 */
export function createLoadedListTrackLoader(
  source: LoadedListSource,
  isSameList: () => boolean = () => true,
): LoadedListTrackLoader {
  return async ({ offset, count, signal }) => {
    const receipts: HttpPageConsumer[] = [];
    let transferred = false;
    const current = () => {
      if (!isSameList()) {
        if (source.assertCurrent) throw holdLoadedList();
        return false;
      }
      try {
        source.assertCurrent?.();
      } catch {
        throw holdLoadedList();
      }
      return true;
    };
    const remember = (list: LoadedList) => {
      if (list.receipt) {
        receipts.push(list.receipt);
        try {
          list.receipt.assertCurrent();
        } catch {
          throw holdLoadedList();
        }
      }
      return list;
    };
    const finish = (climbs: Climb[], nextOffset: number | null): LoadedListTrackLoad => {
      if (!current()) return { climbs: [], nextOffset: null };
      const receipt = combineLoadedListReceipts(receipts, source.assertCurrent);
      receipt?.assertCurrent();
      transferred = true;
      return { climbs, nextOffset, ...(receipt ? { receipt } : {}) };
    };
    try {
      if (!current()) return { climbs: [], nextOffset: null };
      let list = remember(source.read());
      current();
      const end = offset + count;
      let loads = 0;
      let loadsWithoutRows = 0;
      while (list.climbs.length < end && list.hasMore && loads < MAX_LIST_LOADS_PER_TRACK_REQUEST) {
        if (signal.aborted) throw abortError();
        current();
        const loadedRows = list.loadedRows;
        const loaded = await source.loadMore();
        loads += 1;
        if (!('status' in loaded)) list = remember(loaded);
        if (!current()) return { climbs: [], nextOffset: null };
        if ('status' in loaded) {
          if (loaded.status === 'held') throw holdLoadedList();
          loadsWithoutRows += 1;
          if (loadsWithoutRows >= 2) throw holdLoadedList();
          continue;
        }
        current();
        if (list.loadedRows > loadedRows) {
          loadsWithoutRows = 0;
          continue;
        }
        loadsWithoutRows += 1;
        if (loadsWithoutRows >= 2) {
          if (signal.aborted) throw abortError();
          if (source.holdOnNoProgress) throw holdLoadedList();
          return finish(list.climbs.slice(offset, end), null);
        }
      }
      if (signal.aborted) throw abortError();
      const climbs = list.climbs.slice(offset, end);
      const served = offset + climbs.length;
      return finish(climbs, list.climbs.length > served || list.hasMore ? served : null);
    } finally {
      if (!transferred) for (const receipt of receipts) receipt.release();
    }
  };
}

/**
 * A `fetchPage` over a list its screen pages, in whole pages. `isSameList` says whether the
 * screen still shows the list the track was built from: a climber who changes
 * the logbook's filters after the tap gets a track that ends where it is,
 * rather than one that carries on into the other list.
 */
export function createLoadedListFetchPage(source: LoadedListSource, isSameList: () => boolean = () => true): FetchPage {
  return async ({ page, pageSize, signal }) => {
    const receipts: HttpPageConsumer[] = [];
    let transferred = false;
    const current = () => {
      if (!isSameList()) {
        if (source.assertCurrent) throw holdLoadedList();
        return false;
      }
      try {
        source.assertCurrent?.();
      } catch {
        throw holdLoadedList();
      }
      return true;
    };
    const remember = (list: LoadedList) => {
      if (list.receipt) {
        receipts.push(list.receipt);
        try {
          list.receipt.assertCurrent();
        } catch {
          throw holdLoadedList();
        }
      }
      return list;
    };
    const finish = (climbs: Climb[], hasMore: boolean) => {
      if (!current()) return { climbs: [], hasMore: false };
      const receipt = combineLoadedListReceipts(receipts, source.assertCurrent);
      receipt?.assertCurrent();
      transferred = true;
      return { climbs, hasMore, ...(receipt ? { receipt } : {}) };
    };
    try {
      if (!current()) return { climbs: [], hasMore: false };
      let list = remember(source.read());
      current();
      const end = (page + 1) * pageSize;
      let loadsWithoutRows = 0;
      // Whole-page loads keep the native algorithm: a short page with hasMore
      // would skip rows at the next page boundary. Positional tracks above
      // retain their separate five-load bound.
      while (list.climbs.length < end && list.hasMore) {
        if (signal.aborted) throw abortError();
        current();
        const loadedRows = list.loadedRows;
        const loaded = await source.loadMore();
        if (!('status' in loaded)) list = remember(loaded);
        if (!current()) return { climbs: [], hasMore: false };
        if ('status' in loaded) {
          if (loaded.status === 'held') throw holdLoadedList();
          loadsWithoutRows += 1;
          if (loadsWithoutRows >= 2) throw holdLoadedList();
          continue;
        }
        current();
        if (list.loadedRows > loadedRows) {
          loadsWithoutRows = 0;
          continue;
        }
        loadsWithoutRows += 1;
        if (loadsWithoutRows >= 2) {
          if (signal.aborted) throw abortError();
          if (source.holdOnNoProgress) throw holdLoadedList();
          return finish(list.climbs.slice(page * pageSize, end), false);
        }
      }
      if (signal.aborted) throw abortError();
      return finish(list.climbs.slice(page * pageSize, end), list.climbs.length > end || list.hasMore);
    } finally {
      if (!transferred) for (const receipt of receipts) receipt.release();
    }
  };
}
