import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { PlaylistSuggestionSource } from '@boardsesh/queue';
import type { TrackLabelModel } from '@boardsesh/play-view';
import type { QueueNavigationWalk } from '@boardsesh/analytics';
import { hapticSelection } from '../../lib/haptics';
import { announceQueued } from '../../lib/announce-queued';
import type { PlayNavigationSignposts } from './use-play-navigation-model';
import type { PlayNavigationStep } from './use-play-selection-controller';
import type { TrackLabelParts } from './track-label-text';
import {
  crossingLandingAnnouncement,
  formatPreviewNote,
  isListPreview,
  resolveBoardSignpostAccessibility,
  resolveStepWalk,
  resolveUpNextFirstCaption,
  stepEarnsPreviewNote,
  type BoardSignpostAccessibility,
} from './then-signposts';

/**
 * Preview notes shown this app run (the cap is {@link PREVIEW_NOTE_RUN_CAP}).
 * Module state on purpose: a run is the JS process, and the count must survive
 * the player closing and opening again.
 */
let previewNotesThisRun = 0;

/** Tests start each case with a fresh run. */
export function resetPreviewNotesForTests(): void {
  previewNotesThisRun = 0;
}

type ThenSignpostsInput = {
  /** Off in a workout (its stage label keeps the top bar) and for the anonymous reader. */
  enabled: boolean;
  isPreview: boolean;
  previewSource: PlaylistSuggestionSource | null;
  trackLabel: TrackLabelModel;
  trackParts: TrackLabelParts | null;
  signposts: PlayNavigationSignposts;
  displayedClimbUuid: string | null;
  /** Where Next and Previous land now, by climb: a step's landing is matched on these. */
  nextClimbUuid: string | null;
  previousClimbUuid: string | null;
  t: TFunction<'session'>;
  locale: string;
};

export type ThenSignposts = {
  /**
   * "Preview · Up next: 4 waiting", on the preview the first swipe landed on.
   * Line 2 shows it unless the busy wall or a crewmate's put-up outranks it;
   * the player then calls {@link ThenSignposts.markPreviewNoteShown}.
   */
  previewNote: string | null;
  /**
   * The note above is on line 2 now. Spends this open's showing and one of the
   * run's {@link PREVIEW_NOTE_RUN_CAP}, once per note: a note hidden behind a
   * higher caption spends nothing, so the climber still gets to see one.
   */
  markPreviewNoteShown: () => void;
  /** "Up next first · 4 climbs", on the climber's own climb. */
  upNextFirstCaption: string | null;
  board: BoardSignpostAccessibility;
  /**
   * Call with each step the climber takes (`onNavigationStep`), before its
   * landing renders. Sets the note, gives the crossing tick, queues the
   * landing announcement, and returns the walk for `Queue Navigation`.
   */
  onStep: (step: PlayNavigationStep) => QueueNavigationWalk;
  /** A new player open: the note may show once more, and nothing pending carries over. */
  resetForOpen: () => void;
};

/**
 * The player's half of the then-signposts (see `then-signposts.ts`).
 *
 * - The preview note: the first swipe in a list preview while Up next has
 *   climbs swaps "Preview · not on the wall" for "Preview · Up next: 4
 *   waiting" until the next step, with no timer; once per player open and
 *   {@link PREVIEW_NOTE_RUN_CAP} times per app run.
 * - The crossing cue: when the climber's own swipe leaves Up next for the list,
 *   one selection tick (Next and Previous buttons stay silent), and on landing
 *   a screen reader hears "Now in Projects, 8 of 20".
 */
export function useThenSignposts(input: ThenSignpostsInput): ThenSignposts {
  const { enabled, isPreview, previewSource, trackLabel, trackParts, signposts, displayedClimbUuid, t, locale } = input;
  const listPreview = isListPreview({ isPreview, previewSource, trackLabel });

  // A step reads what the walk was when it was taken: the render before it.
  const latestRef = useRef({ ...input, listPreview });
  latestRef.current = { ...input, listPreview };

  // The climb the note was earned for. It shows while that preview is on
  // screen, and the next step takes it away.
  const [noteClimbUuid, setNoteClimbUuid] = useState<string | null>(null);
  const noteClimbUuidRef = useRef<string | null>(null);
  noteClimbUuidRef.current = noteClimbUuid;
  // The note that spent the caps, so one note never spends them twice.
  const countedNoteRef = useRef<string | null>(null);
  const shownThisOpenRef = useRef(false);
  // A crossing step's landing, for the announcement: from the climb it left
  // to the climb it lands on.
  const pendingCrossingRef = useRef<{ from: string | null; to: string } | null>(null);

  const onStep = useCallback((step: PlayNavigationStep): QueueNavigationWalk => {
    const latest = latestRef.current;
    const next = step.direction === 'next';
    const targetClimbUuid = next ? latest.nextClimbUuid : latest.previousClimbUuid;
    const earnsNote =
      targetClimbUuid !== null &&
      stepEarnsPreviewNote({
        enabled: latest.enabled,
        listPreview: latest.listPreview,
        upNextCount: latest.signposts.upNextCount,
        method: step.method,
        outcome: step.outcome,
        shownThisOpen: shownThisOpenRef.current,
        shownThisRun: previewNotesThisRun,
      });
    countedNoteRef.current = null;
    setNoteClimbUuid(earnsNote ? targetClimbUuid : null);

    const crosses = next ? latest.signposts.nextCrosses : latest.signposts.previousCrosses;
    if (latest.enabled && crosses && targetClimbUuid !== null) {
      if (step.method === 'swipe') hapticSelection();
      pendingCrossingRef.current = { from: latest.displayedClimbUuid, to: targetClimbUuid };
    } else {
      pendingCrossingRef.current = null;
    }
    return resolveStepWalk({ direction: step.direction, signposts: latest.signposts, isPreview: latest.isPreview });
  }, []);

  const markPreviewNoteShown = useCallback(() => {
    const shownFor = noteClimbUuidRef.current;
    if (shownFor === null || countedNoteRef.current === shownFor) return;
    countedNoteRef.current = shownFor;
    shownThisOpenRef.current = true;
    previewNotesThisRun += 1;
  }, []);

  const resetForOpen = useCallback(() => {
    shownThisOpenRef.current = false;
    countedNoteRef.current = null;
    pendingCrossingRef.current = null;
    setNoteClimbUuid(null);
  }, []);

  // The landing of a crossing step: announced once the climb it went to is on
  // screen with its list's label; any other change of climb drops it.
  useEffect(() => {
    const pending = pendingCrossingRef.current;
    if (!pending || displayedClimbUuid === pending.from) return;
    pendingCrossingRef.current = null;
    if (displayedClimbUuid !== pending.to) return;
    const announcement = crossingLandingAnnouncement(trackLabel, t, locale);
    if (announcement) announceQueued(announcement);
  }, [displayedClimbUuid, trackLabel, t, locale]);

  const upNextCount = signposts.upNextCount;
  const showNote = enabled && isPreview && noteClimbUuid !== null && noteClimbUuid === displayedClimbUuid;
  const previewNote = showNote && upNextCount > 0 ? formatPreviewNote(upNextCount, t) : null;
  const upNextFirstCaption = resolveUpNextFirstCaption({
    enabled,
    isPreview,
    trackLabel,
    upNextFirstCount: signposts.upNextFirstCount,
    t,
  });
  const board = useMemo(
    () => resolveBoardSignpostAccessibility({ enabled, trackLabel, trackParts, signposts, t }),
    [enabled, trackLabel, trackParts, signposts, t],
  );

  return { previewNote, markPreviewNoteShown, upNextFirstCaption, board, onStep, resetForOpen };
}
