// Pages a swipe track past what is loaded, as the climber nears its end (issue
// #6664). A track used to stop for good about 250 climbs past the tapped one.
//
// The screen that built a track owns its query (the frozen search basis, the
// playlist's sort and filters, the board), and the player is the one that knows
// where the climber is. So the screen registers a page loader here when it
// builds the track and stamps its id on the track (`continuation.loaderId`);
// the player asks for one page through that id when it gets close to the end.
//
// A loader outlives the screen that registered it, on purpose: the player is a
// modal over the list, and a list popped from the stack should not freeze the
// track the climber is still walking. Loaders are not persisted, so a track
// restored from a snapshot after a restart simply ends where it was loaded.

import type { PlaylistSuggestionSource, PlaylistTrackPage } from '@boardsesh/queue';
import { getCredentialGeneration } from '../privacy/privacy-cache';

/**
 * Fetch page `page` of one track, already through that track's own filter.
 * Null means there is nothing to add to the track that asked.
 */
export type TrackPageLoader = (page: number, signal: AbortSignal) => Promise<PlaylistTrackPage | null>;

type RegisteredLoader = {
  load: TrackPageLoader;
  /** Pages loaded under one account must never land in the next one's track. */
  credentialGeneration: number;
};

// Each tap on a list registers one, and only the tracks the climber can still
// reach (the provider's and the player's preview) use theirs. A loader is a
// closure over a screen's query, so a few dozen cost nothing; the cap is there
// so a long session of taps can't grow the map without end. The one evicted is
// the one used longest ago that no reachable track holds (see pinTrackLoader).
const MAX_REGISTERED_LOADERS = 32;

const loaders = new Map<string, RegisteredLoader>();
// The loaders of the tracks the climber can still reach: the committed climb's
// and the player's preview. A crew preview tap registers a loader without
// touching the committed track, so recency alone would let 32 of them evict the
// track the climber is walking.
const pinnedLoaderIds = new Map<'committed' | 'preview', string>();
const inFlight = new Map<string, Promise<PlaylistTrackPage | null>>();
let loaderSequence = 0;
// Ids are stamped on tracks the queue snapshot persists, and the sequence starts
// again at every launch. Without a per-launch part, a track restored from last
// week could match a loader registered today for another list, and page that
// list's climbs into it.
const launchId = Math.random().toString(36).slice(2, 10);

/** Register the loader for a track being built, and get the id to stamp on it. */
export function registerTrackPageLoader(load: TrackPageLoader): string {
  loaderSequence += 1;
  const loaderId = `track-pages-${launchId}-${loaderSequence}`;
  loaders.set(loaderId, { load, credentialGeneration: getCredentialGeneration() });
  const pinned = new Set(pinnedLoaderIds.values());
  while (loaders.size > MAX_REGISTERED_LOADERS) {
    const oldestUnpinned = [...loaders.keys()].find((id) => !pinned.has(id));
    if (oldestUnpinned === undefined) break;
    loaders.delete(oldestUnpinned);
  }
  return loaderId;
}

/**
 * Keep the loader of a track the climber can still reach. The player calls it
 * for the track it walks: `committed` for the committed climb's, `preview` for
 * the drawer's own. A null source releases that role's loader.
 */
export function pinTrackLoader(role: 'committed' | 'preview', source: PlaylistSuggestionSource | null): void {
  const loaderId = source?.continuation?.loaderId;
  if (loaderId) pinnedLoaderIds.set(role, loaderId);
  else pinnedLoaderIds.delete(role);
}

/**
 * A track whose whole list is still loading somewhere else: the background load
 * after a list tap or "Start playlist". Until it settles the player holds the
 * end card back, because the end of what is on screen is not the end of the list.
 *
 * Asked for a page, it waits for that load and adds nothing. When the load put a
 * fuller track in place (`settled` resolves true), the answer is null and lands
 * nowhere, so a late answer can't overwrite the fuller track. When it did not
 * (it failed, was cancelled or skipped), the answer ends this track where it
 * is, so the end card can show.
 */
export function registerPendingTrackLoader(settled: Promise<boolean>): string {
  return registerTrackPageLoader(async (page) => {
    const replaced = await settled.catch(() => false);
    // Ends the track short of its list, so the count no longer fits it.
    return replaced ? null : { page, pageSize: 0, climbs: [], filteredOut: true, nextPage: null };
  });
}

function liveLoader(loaderId: string): RegisteredLoader | null {
  const registered = loaders.get(loaderId);
  if (!registered) return null;
  if (registered.credentialGeneration !== getCredentialGeneration()) {
    loaders.delete(loaderId);
    return null;
  }
  // Most recently used goes last, so eviction takes the one used longest ago.
  loaders.delete(loaderId);
  loaders.set(loaderId, registered);
  return registered;
}

/**
 * Whether more of this track can still be loaded. False for a track whose list
 * ended, and for one whose loader is gone (restored after a restart, evicted,
 * or registered under an account that has since signed out): those tracks end
 * where they were loaded, and the player says so.
 */
export function canLoadMoreOfTrack(source: PlaylistSuggestionSource | null): boolean {
  const loaderId = source?.continuation?.loaderId;
  return loaderId != null && liveLoader(loaderId) !== null;
}

/**
 * The track as the header may count it. A track that still has more of its
 * list but no loader to fetch it (restored after a restart, or registered under
 * an account that signed out) ends where it is, so "250 of 600" would sit next
 * to "That's the whole list". Such a track loses its count.
 */
export function trackForCounting(source: PlaylistSuggestionSource | null): PlaylistSuggestionSource | null {
  if (!source?.continuation || source.total === undefined || canLoadMoreOfTrack(source)) return source;
  const { total: _total, ...uncounted } = source;
  return uncounted;
}

/**
 * Fetch the page after `source`'s last loaded climb, once: a second ask for the
 * same page while the first is out shares it. Resolves null when there is
 * nothing to load.
 *
 * A failed page ends the track where it is (`nextPage: null`) rather than
 * leaving it waiting on a page that is not coming: the climber then gets the
 * end card and the way into their queue, instead of a Next button that stays
 * dead.
 */
export function loadNextTrackPage(source: PlaylistSuggestionSource): Promise<PlaylistTrackPage | null> {
  const continuation = source.continuation;
  if (!continuation) return Promise.resolve(null);
  const registered = liveLoader(continuation.loaderId);
  if (!registered) return Promise.resolve(null);
  const requestKey = `${continuation.loaderId}:${continuation.nextPage}`;
  const pending = inFlight.get(requestKey);
  if (pending) return pending;

  const controller = new AbortController();
  const request = registered
    .load(continuation.nextPage, controller.signal)
    .then((page) => (registered.credentialGeneration === getCredentialGeneration() ? page : null))
    .catch((error: unknown): PlaylistTrackPage | null => {
      if (registered.credentialGeneration !== getCredentialGeneration()) return null;
      console.warn('Loading more of the swipe track failed:', error);
      // The page already had the drain's network retries. Ending here leaves the
      // track short of its list, so the count no longer fits it.
      return { page: continuation.nextPage, pageSize: 0, climbs: [], filteredOut: true, nextPage: null };
    })
    .finally(() => {
      inFlight.delete(requestKey);
    });
  inFlight.set(requestKey, request);
  return request;
}

/** Test-only: forget every loader and request, which are module state. */
export function _resetTrackPagerForTests(): void {
  loaders.clear();
  inFlight.clear();
  pinnedLoaderIds.clear();
  loaderSequence = 0;
}
