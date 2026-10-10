import React, { useSyncExternalStore } from 'react';
import type { BoardName } from '@boardsesh/shared-schema';
import { ClimbListThumbnailPrewarm } from './ClimbListThumbnail';

/**
 * How many loaded climbs past the last visible row get their thumbnail rendered
 * ahead of the scroll. About four screens of rows: enough that a hard flick lands
 * on finished thumbnails, small enough that the mounted set stays bounded.
 */
const THUMBNAIL_PREWARM_ROWS = 24;
/** The window slides in steps this size, so its host re-renders once per step, not once per row. */
const PREWARM_STEP_ROWS = 4;

/**
 * The index of the last climb row on screen, outside React state.
 *
 * FlashList reports viewability on every row that scrolls in. Holding that in
 * the climbs screen's state would re-render the whole screen per row; a store
 * lets the two things that care read it without that — pagination reads it
 * imperatively, and the prewarm window subscribes to a coarsened value.
 */
export type LastVisibleRowStore = {
  get: () => number;
  set: (index: number) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createLastVisibleRowStore(): LastVisibleRowStore {
  let lastVisibleIndex = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => lastVisibleIndex,
    set: (index) => {
      if (index === lastVisibleIndex) return;
      lastVisibleIndex = index;
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

type PrewarmClimb = { uuid: string; frames: string };

type ClimbListThumbnailPrewarmWindowProps = {
  store: LastVisibleRowStore;
  climbs: readonly PrewarmClimb[];
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

/**
 * Warms the thumbnails of the loaded climbs just below the viewport. Renders
 * nothing; see `ClimbListThumbnailPrewarm` for what one warm-up does.
 *
 * Only ever looks down the list: rows above the viewport were on screen a moment
 * ago, so their overlays are already rendered and decoded.
 */
export const ClimbListThumbnailPrewarmWindow = React.memo(function ClimbListThumbnailPrewarmWindow({
  store,
  climbs,
  boardName,
  layoutId,
  sizeId,
  setIds,
}: ClimbListThumbnailPrewarmWindowProps) {
  const windowStart = useSyncExternalStore(
    store.subscribe,
    () => Math.floor(store.get() / PREWARM_STEP_ROWS) * PREWARM_STEP_ROWS,
  );
  // One step of slack on the end, so the window still reaches a full
  // THUMBNAIL_PREWARM_ROWS past the real last row whatever the coarsening dropped.
  const ahead = climbs.slice(windowStart + 1, windowStart + 1 + PREWARM_STEP_ROWS + THUMBNAIL_PREWARM_ROWS);
  return (
    <>
      {ahead.map((climb) => (
        <ClimbListThumbnailPrewarm
          // Keyed on the climb, so sliding the window keeps the warm-ups that are
          // still ahead mounted instead of restarting them.
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
