import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  appendPlaylistTrackPage,
  findPlaylistClimbIndex,
  type PlaylistSuggestionSource,
  type PlaylistTrackPage,
} from '@boardsesh/queue';
import {
  canLoadMoreOfTrack,
  loadNextTrackPage,
  pinTrackLoader,
  takeTrackPageConsumer,
  releaseUnusedTrackPage,
  createTrackPublication,
  sameTrackActivation,
  isTrackPublicationSink,
  MAX_PENDING_TRACK_PUBLICATIONS,
  type TrackPublication,
} from '../../lib/playlists/track-pager';
import { holdLoadedList } from '../../lib/playlists/loaded-list-pages';

/**
 * How close to the end of what is loaded the climber gets before the next page
 * is asked for. A page is 100 climbs, so this asks at the 80th: a few seconds
 * of swiping ahead of the end, which is longer than a page takes to arrive.
 */
export const TRACK_PAGE_LOOKAHEAD = 20;

/** `current` still ends where `requested` did, so the page asked for `requested` is its next one. */
function continuesFrom(current: PlaylistSuggestionSource | null, requested: PlaylistSuggestionSource): boolean {
  return (
    current?.continuation != null &&
    current.continuation.loaderId === requested.continuation?.loaderId &&
    current.continuation.nextPage === requested.continuation.nextPage
  );
}

type TrackPagingInputs = {
  /** The track navigation walks: the preview's own, or the committed climb's. */
  source: PlaylistSuggestionSource | null;
  /**
   * The list climb the walk is at: the climb on screen while it is on the
   * list, or, while a queued climb plays Up next in the middle of the list,
   * the list climb the walk picks up after (`resolveTrackListClimbUuid`,
   * issue #6777). Measured from the queued climb, the list would never page
   * while Up next plays, and would stall at the end of what is loaded.
   */
  listClimbUuid: string | null | undefined;
  /** True when `source` is the pinned preview's track, which lives in the drawer. */
  previewTrack: boolean;
  setPreviewSource: Dispatch<SetStateAction<PlaylistSuggestionSource | null>>;
  /** The provider's track, read when the page lands, to see it still continues from where it was. */
  getCommittedSource: () => PlaylistSuggestionSource | null;
  refreshCommittedSource: (source: PlaylistSuggestionSource, publication?: TrackPublication) => boolean | void;
};

/**
 * Asks for one more page of the track as the climber nears the end of what is
 * loaded (issue #6664). One page per approach, never a drain: the request is
 * keyed on the page, so swiping on while it is out does not send a second one,
 * and the next page is only asked for once this one has landed and the climber
 * is near the new end.
 *
 * A page lands on whichever track asked for it, and only if that track still
 * ends where it did: a track the climber replaced in the meantime, or one a
 * second response already extended, is left alone.
 */
export function useTrackPaging({
  source,
  listClimbUuid,
  previewTrack,
  setPreviewSource,
  getCommittedSource,
  refreshCommittedSource,
}: TrackPagingInputs): void {
  const latestSource = useRef(source);
  latestSource.current = source;
  const owner = useRef({ mounted: true, epoch: 0, pending: new Map<object, TrackPublication>() });
  const [committedPublications, setCommittedPublications] = useState<readonly object[]>([]);
  useLayoutEffect(() => {
    const original = owner.current;
    original.mounted = true;
    return () => {
      original.mounted = false;
      original.epoch += 1;
      for (const publication of original.pending.values()) {
        try {
          publication.settle(null);
        } catch {
          publication.release();
        }
      }
      original.pending.clear();
    };
  }, []);
  useLayoutEffect(() => {
    if (!committedPublications.length) return;
    const acknowledged = new Set(committedPublications);
    for (const id of acknowledged) {
      const publication = owner.current.pending.get(id);
      owner.current.pending.delete(id);
      if (publication) {
        try {
          publication.settle(source);
        } catch {
          publication.release();
        }
      }
    }
    setCommittedPublications((previous) => previous.filter((id) => !acknowledged.has(id)));
  }, [committedPublications, source]);
  // The track the player walks keeps its loader, however many other lists the
  // climber taps meanwhile. A committed walk releases the preview's.
  useEffect(() => {
    pinTrackLoader(previewTrack ? 'preview' : 'committed', source);
    if (!previewTrack) pinTrackLoader('preview', null);
  }, [source, previewTrack]);

  useEffect(() => {
    if (!source?.continuation || !listClimbUuid) return;
    const index = findPlaylistClimbIndex(source, listClimbUuid);
    if (index < 0 || source.climbs.length - 1 - index > TRACK_PAGE_LOOKAHEAD) return;
    if (!canLoadMoreOfTrack(source)) return;
    const originalOwner = owner.current;
    const epoch = originalOwner.epoch;
    const atLastClimb = index === source.climbs.length - 1;
    const land = (page: PlaylistTrackPage | null) => {
      if (!page) return;
      // A page that added nothing and starts the next one where this one did
      // (a logbook's run of repeat-only pages) changes nothing on the track.
      // Landing it anyway would hand the track a new identity, rerun this
      // effect and ask again straight away, page after page with no swipe. So
      // it lands only when the climber is on the last climb and Next waits on
      // it; otherwise the next swipe asks again.
      const stalled = page.climbs.length === 0 && page.nextPage === source.continuation?.nextPage;
      if (stalled && !atLastClimb) {
        releaseUnusedTrackPage(page);
        return;
      }
      let consumer;
      try {
        consumer = takeTrackPageConsumer(page, source);
      } catch {
        releaseUnusedTrackPage(page);
        return;
      }
      if (consumer) {
        let publication: TrackPublication | undefined;
        try {
          const assertOwner = () => {
            if (
              !originalOwner.mounted ||
              originalOwner.epoch !== epoch ||
              !sameTrackActivation(source, latestSource.current)
            )
              throw holdLoadedList();
          };
          publication = createTrackPublication(source, consumer, assertOwner, {
            project: (current) => appendPlaylistTrackPage(current, page),
          });
          publication.assertCurrent();
          if (previewTrack) {
            if (
              originalOwner.pending.size >= MAX_PENDING_TRACK_PUBLICATIONS ||
              originalOwner.pending.has(publication.id) ||
              !publication.claim()
            ) {
              publication.settle(null);
              return;
            }
            const captured = publication;
            originalOwner.pending.set(captured.id, captured);
            // Claim admits this freshly created id only once. Enqueue its
            // exact mark FIRST in the same fiber/lane/batch: the new array marks
            // the fiber pending, preventing React from caching an eager data
            // result before a suspended render can retire the original cause.
            // Neither updater consumes/releases, including during replay.
            setCommittedPublications((previous) =>
              previous.includes(captured.id) ? previous : [...previous, captured.id],
            );
            setPreviewSource((current) => captured.apply(current, (held) => appendPlaylistTrackPage(held, page)));
            return;
          }
          if (!isTrackPublicationSink(refreshCommittedSource)) {
            publication.settle(null);
            return;
          }
          const committed = getCommittedSource();
          publication.assertCurrent();
          if (!committed || !publication.owns(committed) || !continuesFrom(committed, source)) {
            publication.settle(null);
            return;
          }
          const next = appendPlaylistTrackPage(committed, page);
          publication.assertCurrent();
          if (!refreshCommittedSource(next, publication)) publication.settle(null);
          return;
        } catch {
          if (publication) {
            originalOwner.pending.delete(publication.id);
            try {
              publication.settle(null);
            } catch {
              publication.release();
            }
          } else consumer.release();
          return;
        }
      }
      if (previewTrack) {
        setPreviewSource((current) =>
          current && continuesFrom(current, source) ? appendPlaylistTrackPage(current, page) : current,
        );
        return;
      }
      const committed = getCommittedSource();
      if (committed && continuesFrom(committed, source)) {
        refreshCommittedSource(appendPlaylistTrackPage(committed, page));
      }
    };
    void loadNextTrackPage(source).then(land);
  }, [source, listClimbUuid, previewTrack, setPreviewSource, getCommittedSource, refreshCommittedSource]);
}
