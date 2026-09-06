import React from 'react';
import type { BoardName } from '@boardsesh/shared-schema';
import { useNativeClimbRender } from '../../hooks/use-native-climb-render';

type UpcomingBoardPrefetchProps = {
  /** Frames strings for the climbs just ahead in the queue, in swipe order. */
  frames: string[];
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  /**
   * The carousel's measured overlay width. Undefined until the board has been
   * laid out — and a render at the board's native width would land under a
   * different cache key (see `buildCacheKey`'s width token), so there is
   * nothing worth warming yet.
   */
  renderWidth: number | undefined;
};

type PrefetchedBoardRenderProps = Omit<UpcomingBoardPrefetchProps, 'frames'> & { frames: string };

/**
 * One warmed render. Draws nothing: the hook writes the finished PNG into the
 * overlay index and the disk cache, which is the whole product of this mount.
 */
const PrefetchedBoardRender = React.memo(function PrefetchedBoardRender({
  frames,
  boardName,
  layoutId,
  sizeId,
  setIds,
  renderWidth,
}: PrefetchedBoardRenderProps) {
  useNativeClimbRender({
    frames,
    boardName,
    layoutId,
    sizeId,
    setIds,
    // Every input that feeds the cache key has to match what the carousel will
    // ask for, or this warms a PNG nobody looks up: stroke-only (the play
    // board's default `filledStyle`, so it is left unset here) at the
    // carousel's `overlayRenderWidth`. `mirrored` is not in the key — one PNG
    // serves both orientations — and `backgroundVariant` picks the shared board
    // photo rather than the overlay, but it is pinned to the play board's
    // `full` anyway so a prefetch can't warm the wrong photo either.
    renderWidth,
    backgroundVariant: 'full',
    prefetch: true,
  });
  return null;
});

/**
 * Warms the board renders for the next few climbs in the queue while the play
 * drawer is open, so swiping to them paints from cache instead of waiting on a
 * native render (issue #5187). Renders nothing.
 *
 * Safe to mount because of where it sits in the render scheduler: `prefetch` is
 * the lowest rank there, and it dispatches ONLY when nothing else is queued and
 * native is empty. A render somebody is waiting on therefore never queues
 * behind more than one prefetch already inside native, and on a busy drawer
 * these requests simply sit in the queue until the renderer goes idle.
 *
 * They do not accumulate: each child holds at most one undispatched request and
 * the hook's effect cleanup releases it, so a changed `frames` list or an
 * unmounted drawer withdraws the renders that never started.
 */
export const UpcomingBoardPrefetch = React.memo(function UpcomingBoardPrefetch({
  frames,
  boardName,
  layoutId,
  sizeId,
  setIds,
  renderWidth,
}: UpcomingBoardPrefetchProps) {
  if (renderWidth === undefined) return null;

  return (
    <>
      {frames.map((climbFrames) => (
        <PrefetchedBoardRender
          // Keyed on the frames, not the index, so reordering the list (the
          // usual case: the climber swiped one along) moves the mounted child
          // instead of remounting it onto different frames.
          key={climbFrames}
          frames={climbFrames}
          boardName={boardName}
          layoutId={layoutId}
          sizeId={sizeId}
          setIds={setIds}
          renderWidth={renderWidth}
        />
      ))}
    </>
  );
});
