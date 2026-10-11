import React, { useDeferredValue, useSyncExternalStore } from 'react';
import type { BoardName } from '@boardsesh/shared-schema';
import { ClimbListThumbnailPrewarm } from './ClimbListThumbnail';

/**
 * How many loaded climbs past the last visible row get their thumbnail rendered
 * ahead of the scroll. About four screens of rows: enough that a hard flick lands
 * on finished thumbnails, small enough that the mounted set stays bounded.
 */
const PREWARM_ROWS_BELOW = 24;
/**
 * The same, above the first visible row. Fewer, because these rows were on
 * screen once: their overlays are rendered, and only a long list's oldest rows
 * have dropped out of the image memory cache and need decoding again before a
 * scroll back up reaches them.
 */
const PREWARM_ROWS_ABOVE = 12;
/** The window slides in steps this size, so its host re-renders once per step, not once per row. */
const PREWARM_STEP_ROWS = 4;

/**
 * The first and last climb rows on screen, outside React state.
 *
 * FlashList reports viewability on every row that scrolls in. Holding that in
 * the climbs screen's state would re-render the whole screen per row; a store
 * lets the two things that care read it without that — pagination reads it
 * imperatively, and the prewarm window subscribes to a coarsened value.
 */
export type VisibleRowsStore = {
  getFirst: () => number;
  getLast: () => number;
  set: (firstVisibleIndex: number, lastVisibleIndex: number) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createVisibleRowsStore(): VisibleRowsStore {
  let firstVisibleIndex = 0;
  let lastVisibleIndex = 0;
  const listeners = new Set<() => void>();
  return {
    getFirst: () => firstVisibleIndex,
    getLast: () => lastVisibleIndex,
    set: (first, last) => {
      if (first === firstVisibleIndex && last === lastVisibleIndex) return;
      firstVisibleIndex = first;
      lastVisibleIndex = last;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function toStep(index: number): number {
  return Math.floor(index / PREWARM_STEP_ROWS) * PREWARM_STEP_ROWS;
}

type PrewarmClimb = { uuid: string; frames: string };

type ClimbListThumbnailPrewarmWindowProps = {
  store: VisibleRowsStore;
  climbs: readonly PrewarmClimb[];
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

/**
 * Warms the thumbnails of the loaded climbs just outside the viewport, in both
 * directions. Renders nothing; see `ClimbListThumbnailPrewarm` for what one
 * warm-up does.
 */
export const ClimbListThumbnailPrewarmWindow = React.memo(function ClimbListThumbnailPrewarmWindow({
  store,
  climbs,
  boardName,
  layoutId,
  sizeId,
  setIds,
}: ClimbListThumbnailPrewarmWindowProps) {
  const latestFirstStep = useSyncExternalStore(store.subscribe, () => toStep(store.getFirst()));
  const latestLastStep = useSyncExternalStore(store.subscribe, () => toStep(store.getLast()));
  // Deferred, all three: a page landing or the window sliding mounts up to a
  // window's worth of render hooks, and none of it is on screen. Left urgent,
  // those mounts ride in the same commit as the rows the climber is waiting for.
  const firstStep = useDeferredValue(latestFirstStep);
  const lastStep = useDeferredValue(latestLastStep);
  const loadedClimbs = useDeferredValue(climbs);
  // One step of slack below, so the window still reaches a full
  // PREWARM_ROWS_BELOW past the real last row whatever the coarsening dropped.
  const below = loadedClimbs.slice(lastStep + 1, lastStep + 1 + PREWARM_STEP_ROWS + PREWARM_ROWS_BELOW);
  const above = loadedClimbs.slice(Math.max(0, firstStep - PREWARM_ROWS_ABOVE), firstStep);
  return (
    <>
      {[...above, ...below].map((climb) => (
        <ClimbListThumbnailPrewarm
          // Keyed on the climb, so sliding the window keeps the warm-ups that are
          // still outside the viewport mounted instead of restarting them.
          key={climb.uuid}
          frames={climb.frames}
          boardName={boardName}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
        />
      ))}
    </>
  );
});
