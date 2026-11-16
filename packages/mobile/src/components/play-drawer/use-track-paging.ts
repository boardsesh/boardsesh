import { useEffect, type Dispatch, type SetStateAction } from 'react';
import {
  appendPlaylistTrackPage,
  findPlaylistClimbIndex,
  type PlaylistSuggestionSource,
  type PlaylistTrackPage,
} from '@boardsesh/queue';
import { canLoadMoreOfTrack, loadNextTrackPage, pinTrackLoader } from '../../lib/playlists/track-pager';

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
  refreshCommittedSource: (source: PlaylistSuggestionSource) => void;
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
      if (stalled && !atLastClimb) return;
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
