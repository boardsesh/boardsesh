// Pages a swipe track over a list the screen already pages itself (issue
// #6665): the logbook, a profile's climbs. The screen's own query holds the
// list, in its own page size, so the track reads it through that query rather
// than asking the server for the same rows a second way.
//
// Track page `n` is rows n * pageSize up to (n + 1) * pageSize of the list as
// loaded. When the track asks past what is loaded, the screen's query loads
// its next page, one at a time, until the track page is covered or the list
// ends. That only happens as the climber swipes near the end of the track (one
// track page per approach, see `use-track-paging.ts`), never on a tap.

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

/**
 * The most query pages one track page may load. A logbook page is 20 rows and
 * a track page 100 climbs, but the logbook holds a climb once per day it was
 * climbed, so a page of rows can add fewer than 20 climbs. Past this the track
 * page comes back short, which is fine: the next approach asks again.
 */
export const MAX_LOADS_PER_TRACK_PAGE = 10;

function abortError(): Error {
  const error = new Error('Loading the list was cancelled');
  error.name = 'AbortError';
  return error;
}

/**
 * A `fetchPage` over a list its screen pages. `isSameList` says whether the
 * screen still shows the list the track was built from: a climber who changes
 * the logbook's filters after the tap gets a track that ends where it is,
 * rather than one that carries on into the other list.
 */
export function createLoadedListFetchPage(source: LoadedListSource, isSameList: () => boolean = () => true): FetchPage {
  return async ({ page, pageSize, signal }) => {
    if (!isSameList()) return { climbs: [], hasMore: false };
    let list = source.read();
    const end = (page + 1) * pageSize;
    for (let loads = 0; list.climbs.length < end && list.hasMore && loads < MAX_LOADS_PER_TRACK_PAGE; loads += 1) {
      if (signal.aborted) throw abortError();
      const loadedRows = list.loadedRows;
      list = await source.loadMore();
      if (!isSameList()) return { climbs: [], hasMore: false };
      // A load that added no rows would only repeat itself.
      if (list.loadedRows <= loadedRows) break;
    }
    if (signal.aborted) throw abortError();
    return {
      climbs: list.climbs.slice(page * pageSize, end),
      hasMore: list.climbs.length > end || list.hasMore,
    };
  };
}
