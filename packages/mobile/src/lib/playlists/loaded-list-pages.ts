// Pages a swipe track over a list the screen already pages itself (issue
// #6665): the logbook, a profile's climbs. The screen's own query holds the
// list, in its own page size, so the track reads it through that query rather
// than asking the server for the same rows a second way.
//
// Track page `n` is climbs n * pageSize up to (n + 1) * pageSize of the list as
// loaded, always whole unless the list ends inside it. When the track asks past what is loaded, the screen's query loads
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
    // No cap on the loads: the next track page starts at the next page
    // boundary, so a page that came back short with more behind it would skip
    // every climb between its end and that boundary. A logbook holds a climb
    // once per day it was climbed, so covering 100 climbs can take more than
    // five 20-row pages. The loop still ends: at the list's end, on two loads
    // in a row that added no rows, on another list, or on an abort.
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
      // One load that added nothing is usually a refetch in flight: logging a
      // tick refetches the logbook, and a load asked for meanwhile resolves
      // with that refetch's pages. Once it settles the next load is real, so
      // only a second one in a row means the list is stuck.
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
