import { useCallback, useEffect, useRef } from 'react';
import type { ClimbQueueItem, PlaylistSuggestionSource, SetCurrentClimbOptions } from '@boardsesh/queue';
import { clearLastPick, setLastPick } from '../../lib/last-pick-store';
import type { AppliedPlayerOpen } from './use-play-selection-controller';

/** What the player shows, as far as the last pick goes. */
type ShownPick = {
  item: ClimbQueueItem | null;
  source: PlaylistSuggestionSource | null;
  mirrored: boolean;
};

/** The wall as it was when the climber started looking, and when. */
export type PickLatchStart = { wallClimbUuid: string | null; at: number };

export type LastPickWriterInputs = {
  /** False for the signed-out reader: there is no bar to show it. */
  enabled: boolean;
  /** The player's pinned preview, or null while it shows the committed climb. */
  previewItem: ClimbQueueItem | null;
  previewSuggestionSource: PlaylistSuggestionSource | null;
  /** The preview's mirror as drawn (ignored without a preview). */
  previewMirrored: boolean;
  /** The slot's deferred commit, for the preview on screen only. */
  getCommitOptions: () => SetCurrentClimbOptions | undefined;
  /** The queue's current item now: a later one ends the pick. */
  getCurrentItemUuid: () => string | null;
  /** The busy-wall snapshot to keep with the pick: the latch's start while one holds, else the wall now. */
  getLatchStart: () => PickLatchStart;
};

function sameShown(left: ShownPick, right: ShownPick): boolean {
  return left.item === right.item && left.source === right.source && left.mirrored === right.mirrored;
}

/**
 * The player is the one writer of the climber's last pick (owner decision A,
 * `lib/last-pick-store.ts`): the climb they most recently opened, a preview
 * included, for the MiniPlayer to show once the player closes.
 *
 * - An open the player applies (`noteOpenApplied`, from the selection
 *   controller) is a pick: a preview records it, a committed climb ends any
 *   pick (the bar then shows the queue's current). A pane's REPLAY of a target
 *   another pane already applied is a look, never a new pick: hours later it
 *   must not bring back a pick the queue has moved past.
 * - After that, every change of what the player shows is the climber's latest
 *   look: a swipe to another preview, the mirror flip, a similar climb, Back
 *   to my pick (the pick ends), Put on board (the pick ends; the queue's new
 *   current takes the bar).
 *
 * The open's own state landing a render later is not a second write, and the
 * first render's seeded state (the route seeds the preview from its target)
 * writes nothing: only a change does.
 */
export function useLastPickWriter({
  enabled,
  previewItem,
  previewSuggestionSource,
  previewMirrored,
  getCommitOptions,
  getCurrentItemUuid,
  getLatchStart,
}: LastPickWriterInputs): { noteOpenApplied: (applied: AppliedPlayerOpen) => void } {
  const shown: ShownPick = {
    item: previewItem,
    source: previewItem ? previewSuggestionSource : null,
    mirrored: previewItem ? previewMirrored : false,
  };
  const seenRef = useRef<ShownPick>(shown);
  // The last state written (or, for a replay, deliberately not written).
  const writtenRef = useRef<ShownPick | null>(null);
  const latest = useRef({ enabled, getCommitOptions, getCurrentItemUuid, getLatchStart });
  latest.current = { enabled, getCommitOptions, getCurrentItemUuid, getLatchStart };

  const write = useCallback(
    (state: ShownPick, commitOptions: SetCurrentClimbOptions | undefined, latchStart: PickLatchStart) => {
      if (!state.item) {
        clearLastPick();
        return;
      }
      setLastPick({
        item: state.item,
        suggestionSource: state.source,
        commitOptions,
        mirrored: state.mirrored,
        currentAtPick: latest.current.getCurrentItemUuid(),
        wallAtPick: latchStart.wallClimbUuid,
        pickedAt: latchStart.at,
      });
    },
    [],
  );

  const noteOpenApplied = useCallback(
    (applied: AppliedPlayerOpen) => {
      const state: ShownPick = {
        item: applied.previewItem,
        source: applied.previewItem ? applied.suggestionSource : null,
        mirrored: applied.previewItem ? applied.mirrored : false,
      };
      writtenRef.current = state;
      if (applied.replay || !latest.current.enabled) return;
      write(state, applied.commitOptions, applied.latchStart ?? latest.current.getLatchStart());
    },
    [write],
  );

  const { item, source, mirrored } = shown;
  useEffect(() => {
    const state: ShownPick = { item, source, mirrored };
    const seen = seenRef.current;
    seenRef.current = state;
    if (sameShown(seen, state)) return;
    if (writtenRef.current && sameShown(writtenRef.current, state)) return;
    writtenRef.current = state;
    if (!latest.current.enabled) return;
    write(state, item ? latest.current.getCommitOptions() : undefined, latest.current.getLatchStart());
  }, [item, source, mirrored, write]);

  return { noteOpenApplied };
}
