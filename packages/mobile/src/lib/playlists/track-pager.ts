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
import type { HttpPageConsumer } from '../graphql/use-http-query';
import { holdLoadedList, isLoadedListHeld, combineLoadedListReceipts } from './loaded-list-pages';

/**
 * Fetch page `page` of one track, already through that track's own filter.
 * Null means there is nothing to add to the track that asked.
 */
export type TrackPageLoader = (page: number, signal: AbortSignal) => Promise<PlaylistTrackPage | null>;

type RegisteredLoader = {
  id: string;
  load: TrackPageLoader;
  /** Pages loaded under one account must never land in the next one's track. */
  credentialGeneration: number;
  ownership?: Readonly<TrackLoaderOwnership>;
  retired: boolean;
  requests: Set<{ cancel: () => void }>;
};

export type TrackLoaderOwnership = {
  assertCurrent: () => void;
  dispose?: () => void;
};

type PageProvenance = { consumer: HttpPageConsumer; registered?: RegisteredLoader };
const pageProvenance = new WeakMap<PlaylistTrackPage, PageProvenance>();

/** Only an actual captured list conversion supplies the original causes. */
export function bindTrackPageReceipt(page: PlaylistTrackPage, consumer: HttpPageConsumer): PlaylistTrackPage {
  consumer.assertCurrent();
  pageProvenance.set(page, { consumer });
  return page;
}

function assertRegistered(registered: RegisteredLoader): void {
  if (
    registered.retired ||
    loaders.get(registered.id) !== registered ||
    registered.credentialGeneration !== getCredentialGeneration()
  )
    throw holdLoadedList();
  registered.ownership?.assertCurrent();
  if (registered.retired || registered.credentialGeneration !== getCredentialGeneration()) throw holdLoadedList();
}

/** One returned page object belongs to one waiter. Copies cannot claim it. */
export function takeTrackPageConsumer(
  page: PlaylistTrackPage,
  source: PlaylistSuggestionSource,
): HttpPageConsumer | null {
  const provenance = pageProvenance.get(page);
  if (!provenance) {
    const registered = source.continuation && loaders.get(source.continuation.loaderId);
    if (registered?.ownership) throw holdLoadedList();
    return null;
  }
  pageProvenance.delete(page);
  try {
    const registered = provenance.registered;
    if (!registered || source.continuation?.loaderId !== registered.id || source.continuation.nextPage !== page.page)
      throw holdLoadedList();
    assertRegistered(registered);
    provenance.consumer.assertCurrent();
    return provenance.consumer;
  } catch (error) {
    provenance.consumer.release();
    throw error;
  }
}

export function releaseUnusedTrackPage(page: PlaylistTrackPage): void {
  const provenance = pageProvenance.get(page);
  pageProvenance.delete(page);
  provenance?.consumer.release();
}

const activationIdentity = Symbol('original track activation');
const appliedPublications = Symbol('applied track publications');
const acknowledgedPublications = new WeakSet<object>();
type PrivateTrackSource = PlaylistSuggestionSource & {
  [activationIdentity]?: object;
  [appliedPublications]?: readonly object[];
};

/** Identity locates the accepted action; it never supplies network authority. */
export function bindTrackActivation(source: PlaylistSuggestionSource, identity: object): PlaylistSuggestionSource {
  return { ...source, [activationIdentity]: identity, [appliedPublications]: Object.freeze([]) } as PrivateTrackSource;
}

export const MAX_PENDING_TRACK_PUBLICATIONS = 32;

export function sameTrackActivation(
  first: PlaylistSuggestionSource | null,
  second: PlaylistSuggestionSource | null,
): boolean {
  return (
    !!first &&
    !!second &&
    first.playlistUuid === second.playlistUuid &&
    first.activatedClimbUuid === second.activatedClimbUuid &&
    first.boardKey === second.boardKey &&
    (first as PrivateTrackSource)[activationIdentity] !== undefined &&
    (first as PrivateTrackSource)[activationIdentity] === (second as PrivateTrackSource)[activationIdentity]
  );
}

export type TrackPublicationOutcome = 'applied' | 'held' | 'retired';
export type TrackPublication = Readonly<{
  id: object;
  assertCurrent: () => void;
  claim: () => boolean;
  owns: (source: PlaylistSuggestionSource | null) => boolean;
  apply: (
    current: PlaylistSuggestionSource | null,
    build: (current: PlaylistSuggestionSource) => PlaylistSuggestionSource,
  ) => PlaylistSuggestionSource | null;
  settle: (committed: PlaylistSuggestionSource | null) => TrackPublicationOutcome;
  release: () => void;
}>;

type TrackPublicationSink = (source: PlaylistSuggestionSource, publication?: TrackPublication) => boolean;
const publicationSinks = new WeakSet<object>();
/** Identifies the actual guard-consuming sink; this is not data authority. */
export function bindTrackPublicationSink<Sink extends TrackPublicationSink>(sink: Sink): Sink {
  publicationSinks.add(sink);
  return sink;
}
export function isTrackPublicationSink(candidate: unknown): candidate is TrackPublicationSink {
  return typeof candidate === 'function' && publicationSinks.has(candidate);
}

/** Retained outside React; updater assertions are pure/repeatable. Exact
 * commit marks, not setter return values, settle this captured publication. */
export function createTrackPublication(
  expectedSource: PlaylistSuggestionSource,
  consumer: HttpPageConsumer,
  assertOwner: () => void,
  options: {
    onSettled?: (outcome: TrackPublicationOutcome) => void;
    project?: (current: PlaylistSuggestionSource) => PlaylistSuggestionSource;
  } = {},
): TrackPublication {
  const { onSettled, project } = options;
  const expected = expectedSource as PrivateTrackSource;
  const originalActivation = expected[activationIdentity];
  if (!originalActivation) {
    consumer.release();
    throw holdLoadedList();
  }
  const expectedLoader = expected.continuation?.loaderId;
  const expectedCursor = expected.continuation?.nextPage;
  const expectedPlaylist = expected.playlistUuid;
  const expectedClimb = expected.activatedClimbUuid;
  const expectedBoard = expected.boardKey;
  const id = Object.freeze({});
  const cancellation = new AbortController();
  let released = false;
  let claimed = false;
  let settlement: TrackPublicationOutcome | undefined;
  const assertCurrent = () => {
    if (cancellation.signal.aborted) throw holdLoadedList();
    assertOwner();
    consumer.assertCurrent();
    assertOwner();
  };
  const matches = (current: PlaylistSuggestionSource): boolean =>
    current.playlistUuid === expectedPlaylist &&
    current.activatedClimbUuid === expectedClimb &&
    current.boardKey === expectedBoard &&
    (current as PrivateTrackSource)[activationIdentity] === originalActivation &&
    current.continuation?.loaderId === expectedLoader &&
    current.continuation?.nextPage === expectedCursor;
  const release = () => {
    if (released) return;
    released = true;
    consumer.release();
  };
  return Object.freeze({
    id,
    assertCurrent,
    release,
    claim() {
      if (claimed || released || settlement) return false;
      assertCurrent();
      claimed = true;
      return true;
    },
    owns: (source) => sameTrackActivation(expected, source),
    apply(current, build) {
      try {
        assertCurrent();
        if (!current || !matches(current)) return current;
        const next = (project ?? build)(current) as PrivateTrackSource;
        assertCurrent();
        if (!matches(current)) return current;
        const applied = new Set<object>();
        for (const previous of [current as PrivateTrackSource, next])
          for (const ticket of previous[appliedPublications] ?? [])
            if (!acknowledgedPublications.has(ticket)) applied.add(ticket);
        if (!acknowledgedPublications.has(id)) applied.add(id);
        if (applied.size > MAX_PENDING_TRACK_PUBLICATIONS * 2) return current;
        assertCurrent();
        return {
          ...next,
          [activationIdentity]: originalActivation,
          [appliedPublications]: Object.freeze([...applied]),
        } as PrivateTrackSource;
      } catch {
        return current;
      }
    },
    settle(committed) {
      if (settlement) return settlement;
      const applied = (committed as PrivateTrackSource | null)?.[appliedPublications]?.includes(id) ?? false;
      try {
        assertCurrent();
        settlement = applied ? 'applied' : 'held';
        if (applied) consumer.acknowledge();
      } catch {
        settlement = 'retired';
      }
      acknowledgedPublications.add(id);
      if (settlement !== 'applied') cancellation.abort(holdLoadedList());
      try {
        onSettled?.(settlement);
      } finally {
        release();
      }
      return settlement;
    },
  });
}

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
type GuardedWaiter = { resolve: (page: PlaylistTrackPage | null) => void };
type GuardedRequest = { waiters: Set<GuardedWaiter>; cancel: () => void };
const guardedInFlight = new Map<string, GuardedRequest>();
let loaderSequence = 0;
// Ids are stamped on tracks the queue snapshot persists, and the sequence starts
// again at every launch. Without a per-launch part, a track restored from last
// week could match a loader registered today for another list, and page that
// list's climbs into it.
const launchId = Math.random().toString(36).slice(2, 10);

/** Register the loader for a track being built, and get the id to stamp on it. */
export function registerTrackPageLoader(load: TrackPageLoader, ownership?: TrackLoaderOwnership): string {
  loaderSequence += 1;
  const loaderId = `track-pages-${launchId}-${loaderSequence}`;
  loaders.set(loaderId, {
    id: loaderId,
    load,
    credentialGeneration: getCredentialGeneration(),
    ...(ownership ? { ownership: Object.freeze({ ...ownership }) } : {}),
    retired: false,
    requests: new Set(),
  });
  const pinned = new Set(pinnedLoaderIds.values());
  while (loaders.size > MAX_REGISTERED_LOADERS) {
    const oldestUnpinned = [...loaders.keys()].find((id) => !pinned.has(id));
    if (oldestUnpinned === undefined) break;
    retireLoader(loaders.get(oldestUnpinned)!);
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
export function registerPendingTrackLoader(settled: Promise<boolean>, ownership?: TrackLoaderOwnership): string {
  return registerTrackPageLoader(async (page) => {
    ownership?.assertCurrent();
    const replaced = await settled.catch(() => false);
    ownership?.assertCurrent();
    // Ends the track short of its list, so the count no longer fits it.
    if (replaced) return null;
    const terminal: PlaylistTrackPage = { page, pageSize: 0, climbs: [], filteredOut: true, nextPage: null };
    return ownership
      ? bindTrackPageReceipt(terminal, combineLoadedListReceipts([], ownership.assertCurrent)!)
      : terminal;
  }, ownership);
}

function retireLoader(registered: RegisteredLoader): void {
  if (registered.retired) return;
  registered.retired = true;
  if (loaders.get(registered.id) === registered) loaders.delete(registered.id);
  for (const request of registered.requests) request.cancel();
  try {
    registered.ownership?.dispose?.();
  } catch {
    /* Retirement never publishes diagnostics. */
  }
}

function liveLoader(loaderId: string): RegisteredLoader | null {
  const registered = loaders.get(loaderId);
  if (!registered) return null;
  if (registered.credentialGeneration !== getCredentialGeneration()) {
    retireLoader(registered);
    return null;
  }
  if (registered.ownership) {
    try {
      assertRegistered(registered);
    } catch {
      retireLoader(registered);
      return null;
    }
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

function loadGuardedTrackPage(
  registered: RegisteredLoader,
  nextPage: number,
  requestKey: string,
): Promise<PlaylistTrackPage | null> {
  let request = guardedInFlight.get(requestKey);
  if (!request) {
    if (registered.requests.size >= MAX_REGISTERED_LOADERS) return Promise.resolve(null);
    const controller = new AbortController();
    const waiters = new Set<GuardedWaiter>();
    request = {
      waiters,
      cancel() {
        controller.abort(holdLoadedList());
        for (const waiter of waiters) waiter.resolve(null);
        waiters.clear();
      },
    };
    const original = request;
    guardedInFlight.set(requestKey, original);
    registered.requests.add(original);
    void (async () => {
      let rootConsumer: HttpPageConsumer | undefined;
      let returnedPage: PlaylistTrackPage | null = null;
      try {
        await Promise.resolve();
        assertRegistered(registered);
        let page: PlaylistTrackPage | null;
        try {
          page = await registered.load(nextPage, controller.signal);
          returnedPage = page;
        } catch (error) {
          assertRegistered(registered);
          if (controller.signal.aborted || isLoadedListHeld(error)) return;
          // Preserve genuine current errors, while a reentrant diagnostic may
          // not authorize the following terminal publication under a new view.
          try {
            console.warn('Loading more of the swipe track failed:', error);
          } catch {
            /* Observational only. */
          }
          assertRegistered(registered);
          page = bindTrackPageReceipt(
            { page: nextPage, pageSize: 0, climbs: [], filteredOut: true, nextPage: null },
            combineLoadedListReceipts([], () => assertRegistered(registered))!,
          );
        }
        assertRegistered(registered);
        if (!page) return;
        const provenance = pageProvenance.get(page);
        pageProvenance.delete(page);
        if (!provenance) throw holdLoadedList();
        rootConsumer = provenance.consumer;
        rootConsumer.assertCurrent();
        for (const waiter of waiters) {
          assertRegistered(registered);
          const consumer = rootConsumer.retain();
          const delivered = { ...page };
          pageProvenance.set(delivered, { consumer, registered });
          waiter.resolve(delivered);
        }
        waiters.clear();
      } catch {
        // Unknown ownership/cause refusals are holds, never synthetic pages.
      } finally {
        rootConsumer?.release();
        if (!rootConsumer && returnedPage) releaseUnusedTrackPage(returnedPage);
        for (const waiter of waiters) waiter.resolve(null);
        waiters.clear();
        registered.requests.delete(original);
        if (guardedInFlight.get(requestKey) === original) guardedInFlight.delete(requestKey);
      }
    })();
  }
  if (request.waiters.size >= MAX_REGISTERED_LOADERS) return Promise.resolve(null);
  return new Promise((resolve) => request!.waiters.add({ resolve }));
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
  if (registered.ownership) return loadGuardedTrackPage(registered, continuation.nextPage, requestKey);
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
  for (const registered of loaders.values()) retireLoader(registered);
  loaders.clear();
  inFlight.clear();
  guardedInFlight.clear();
  pinnedLoaderIds.clear();
  loaderSequence = 0;
}
