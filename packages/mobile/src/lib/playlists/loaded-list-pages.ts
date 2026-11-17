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
};

export type LoadedListSource = {
  read: () => LoadedList;
  /**
   * Load the query's next page; resolves with the list as loaded after it.
   * Rejects when the page fails, which ends the track where it is.
   */
  loadMore: () => Promise<LoadedList>;
};

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
    if (!isSameList()) return { climbs: [], nextOffset: null };
    let list = source.read();
    const end = offset + count;
    let loads = 0;
    let loadsWithoutRows = 0;
    while (list.climbs.length < end && list.hasMore && loads < MAX_LIST_LOADS_PER_TRACK_REQUEST) {
      if (signal.aborted) throw abortError();
      const loadedRows = list.loadedRows;
      list = await source.loadMore();
      loads += 1;
      if (!isSameList()) return { climbs: [], nextOffset: null };
      if (list.loadedRows > loadedRows) {
        loadsWithoutRows = 0;
        continue;
      }
      // One load that added nothing is usually a refetch in flight: logging a
      // tick refetches the logbook, and a load asked for meanwhile resolves
      // with that refetch's pages. Once it settles the next load is real, so
      // only a second one in a row means the list is stuck, and the track ends.
      loadsWithoutRows += 1;
      if (loadsWithoutRows >= 2) {
        if (signal.aborted) throw abortError();
        return { climbs: list.climbs.slice(offset, end), nextOffset: null };
      }
    }
    if (signal.aborted) throw abortError();
    const climbs = list.climbs.slice(offset, end);
    const served = offset + climbs.length;
    return { climbs, nextOffset: list.climbs.length > served || list.hasMore ? served : null };
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
    if (!isSameList()) return { climbs: [], hasMore: false };
    let list = source.read();
    const end = (page + 1) * pageSize;
    // No cap on the loads: the next page starts at the next page boundary, so
    // a page that came back short with more behind it would skip every climb
    // between its end and that boundary. Tracks don't page this way (see
    // `createLoadedListTrackLoader`). The loop still ends: at the list's end,
    // on two loads in a row that added no rows, on another list, or on an abort.
    let loadsWithoutRows = 0;
    while (list.climbs.length < end && list.hasMore) {
      if (signal.aborted) throw abortError();
      const loadedRows = list.loadedRows;
      list = await source.loadMore();
      if (!isSameList()) return { climbs: [], hasMore: false };
      if (list.loadedRows > loadedRows) {
        loadsWithoutRows = 0;
        continue;
      }
      // A refetch in flight, or a stuck list: see `createLoadedListTrackLoader`.
      loadsWithoutRows += 1;
      if (loadsWithoutRows >= 2) {
        // Give up by ending the track here. A short page that still said
        // `hasMore` would send the next page to the next boundary and skip
        // every climb in between.
        if (signal.aborted) throw abortError();
        return { climbs: list.climbs.slice(page * pageSize, end), hasMore: false };
      }
    }
    if (signal.aborted) throw abortError();
    return {
      climbs: list.climbs.slice(page * pageSize, end),
      hasMore: list.climbs.length > end || list.hasMore,
    };
  };
}
