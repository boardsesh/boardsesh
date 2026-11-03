// The then-signposts (owner-approved 2026-11-02): the player says where the
// next swipe goes when it would leave the list named at the top.
//
// The rule a climber can say: "Swipes walk the list named at the top. My Up
// next plays from my own climb, and the player says *then* before a swipe
// switches." Everything here reads the walk's own steps
// (`PlayNavigationSignposts`, built from the same selectors that decide the
// swipe), so a sign can never promise a climb the swipe won't land on.
//
// With Up next empty none of it shows: no tail, no note, no tick. A workout's
// stage label keeps the top bar, so a workout shows none of it either.

import type { TFunction } from 'i18next';
import type { PlaylistSuggestionSource } from '@boardsesh/queue';
import { trackLabelListName, type TrackLabelModel } from '@boardsesh/play-view';
import type { QueueNavigationDirection, QueueNavigationWalk } from '@boardsesh/analytics';
import { getCachedNumberFormat } from '../../lib/intl-formatter-cache';
import type { PlayNavigationSignposts } from './use-play-navigation-model';
import type { TrackLabelParts } from './track-label-text';

/** A list the top bar names: the only walks the signposts talk about. */
function namesList(trackLabel: TrackLabelModel): boolean {
  return trackLabel.kind === 'named' || trackLabel.kind === 'counted';
}

/**
 * "Up next first · 4 climbs", the top bar's second line on the climber's own
 * climb while it sits on the list named above and Next steps into Up next. The
 * count is the Up next the walk plays before the list goes on, the total
 * "Up next · 1 of 4" then reads. Null on a preview, off a list, while Next
 * stays on the list, and in a workout.
 */
export function resolveUpNextFirstCaption({
  enabled,
  isPreview,
  trackLabel,
  upNextFirstCount,
  t,
}: {
  enabled: boolean;
  isPreview: boolean;
  trackLabel: TrackLabelModel;
  upNextFirstCount: number | null;
  t: TFunction<'session'>;
}): string | null {
  if (!enabled || isPreview || upNextFirstCount === null || upNextFirstCount <= 0) return null;
  if (!namesList(trackLabel)) return null;
  // The queue holds at most 500 climbs, so the count needs no grouping.
  return t('playView.track.upNextFirst', { count: upNextFirstCount });
}

/**
 * A preview opened on a list (a tap in search results, a playlist, the last
 * pick reopened), walking that list. Its swipes never play Up next, so Up next
 * waits behind it. A look that stepped off the climber's own climb
 * (`lookOffWall`, #7227) walks Up next itself and is not one.
 */
export function isListPreview({
  isPreview,
  previewSource,
  trackLabel,
}: {
  isPreview: boolean;
  previewSource: PlaylistSuggestionSource | null;
  trackLabel: TrackLabelModel;
}): boolean {
  return isPreview && previewSource !== null && previewSource.lookOffWall !== true && namesList(trackLabel);
}

/** The note's caps: once per player open, and this many times per app run. */
export const PREVIEW_NOTE_RUN_CAP = 3;

/**
 * Whether a step earns the preview note, "Preview · Up next: 4 waiting": the
 * climber's own swipe off a list preview that opens the next preview, while Up
 * next has climbs, before a note has shown this open and within the run's cap.
 * Earning it is not showing it: the busy wall and a crewmate's put-up outrank
 * it on line 2, and only a note that showed spends the caps.
 */
export function stepEarnsPreviewNote({
  enabled,
  listPreview,
  upNextCount,
  method,
  outcome,
  shownThisOpen,
  shownThisRun,
}: {
  enabled: boolean;
  listPreview: boolean;
  upNextCount: number;
  method: 'button' | 'swipe';
  outcome: 'moved' | 'preview';
  shownThisOpen: boolean;
  shownThisRun: number;
}): boolean {
  return (
    enabled &&
    listPreview &&
    upNextCount > 0 &&
    method === 'swipe' &&
    outcome === 'preview' &&
    !shownThisOpen &&
    shownThisRun < PREVIEW_NOTE_RUN_CAP
  );
}

/**
 * "Preview · Up next: 4 waiting", pluralised by the count. Every language puts
 * the count before anything the line may cut. The queue holds at most 500
 * climbs, so the count needs no grouping.
 */
export function formatPreviewNote(upNextCount: number, t: TFunction<'session'>): string {
  return t('playView.track.previewUpNextWaiting', { count: upNextCount });
}

/**
 * The note as line 2 shows it: the busy-wall question and a crewmate's put-up
 * outrank it there, so null while either is up. Only a note that shows spends
 * its caps, and only it is read as the board's value.
 */
export function resolvePreviewNoteOnLine({
  previewNote,
  busyWallUp,
  letsGoCaption = null,
  crewPutUpCaption,
}: {
  previewNote: string | null;
  busyWallUp: boolean;
  /** The board let go mid-drive (`use-board-lets-go.ts`): it outranks the note on line 2. */
  letsGoCaption?: string | null;
  crewPutUpCaption: string | null;
}): string | null {
  return busyWallUp || letsGoCaption !== null || crewPutUpCaption !== null ? null : previewNote;
}

/** What the step did to the walk, for `Queue Navigation`'s `track`, `from`, `upNextBucket` and `crossed`. */
export function resolveStepWalk({
  direction,
  signposts,
  isPreview,
}: {
  direction: QueueNavigationDirection;
  signposts: PlayNavigationSignposts;
  isPreview: boolean;
}): QueueNavigationWalk {
  const next = direction === 'next';
  return {
    track: next ? signposts.nextTrack : signposts.previousTrack,
    from: isPreview ? 'preview' : 'current',
    upNextCount: signposts.upNextCount,
    crossed: next ? signposts.nextCrosses : signposts.previousCrosses,
  };
}

/** The board's screen-reader extras. Absent fields leave the board as it was. */
export type BoardSignpostAccessibility = {
  /** "Up next, 4 of 4, then Projects" on a climb that plays Up next. */
  valueText?: string;
  /** "Next in Projects" when Next leaves Up next for the list. */
  nextActionLabel?: string;
  /** "Previous in Projects" when Previous leaves Up next for the list. */
  previousActionLabel?: string;
};

const NO_BOARD_SIGNPOSTS: BoardSignpostAccessibility = {};

/**
 * What the board (the swipe's screen-reader stand-in, an adjustable element)
 * says about the walk: its value names the Up next stretch and what comes
 * after it, and the action that crosses into the list is named for that list.
 * Nothing new off Up next, for a list nobody named, or in a workout.
 */
export function resolveBoardSignpostAccessibility({
  enabled,
  trackLabel,
  trackParts,
  signposts,
  t,
}: {
  enabled: boolean;
  trackLabel: TrackLabelModel;
  trackParts: TrackLabelParts | null;
  signposts: PlayNavigationSignposts;
  t: TFunction<'session'>;
}): BoardSignpostAccessibility {
  if (!enabled || trackLabel.kind !== 'upNext') return NO_BOARD_SIGNPOSTS;
  const listName = trackLabelListName(trackLabel);
  return {
    valueText: trackParts?.accessibilityLabel,
    nextActionLabel: signposts.nextCrosses && listName ? t('playView.track.nextIn', { name: listName }) : undefined,
    previousActionLabel:
      signposts.previousCrosses && listName ? t('playView.track.previousIn', { name: listName }) : undefined,
  };
}

/**
 * What a screen reader hears on landing after a step crossed into the list:
 * "Now in Projects, 8 of 20". Null for a list nobody named.
 */
export function crossingLandingAnnouncement(
  trackLabel: TrackLabelModel,
  t: TFunction<'session'>,
  locale: string,
): string | null {
  if (trackLabel.kind === 'named') return t('playView.track.nowIn', { name: trackLabel.name });
  if (trackLabel.kind !== 'counted') return null;
  const numbers = getCachedNumberFormat(locale);
  return t('playView.track.nowInPosition', {
    name: trackLabel.name,
    position: numbers.format(trackLabel.position),
    total: numbers.format(trackLabel.total),
  });
}
