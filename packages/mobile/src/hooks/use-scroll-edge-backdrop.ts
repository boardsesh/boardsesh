import { useCallback, useEffect, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { useListTopOffset } from './use-list-top-offset';

/**
 * Points a list must travel past its resting top before its rows count as being
 * under the controls. Absorbs sub-point offsets and the last frame of a bounce.
 */
export const SCROLL_EDGE_SLACK = 2;

export type ScrollEdgeBackdrop = {
  /** Hand this to the list. It sets state only when `scrolledUnder` flips. */
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /** True while the list is scrolled past its resting top, under the controls. */
  scrolledUnder: boolean;
};

type Tracker = {
  /** The list's last reported offset; null until it has scrolled at all. */
  offset: number | null;
  /** The resting top under the bar at its shortest (see below). */
  restingTop: number;
  scrolledUnder: boolean;
};

/**
 * Tells a root tab's top chrome whether its list has scrolled under the controls
 * pinned below the bar, so the blur behind them shows only then. The system's
 * own scroll edge effect behaves this way: at rest the page is the page.
 *
 * The comparison is the list's offset against its resting top
 * (`useListTopOffset`). Anything at or above that top is at rest, which covers
 * the rubber-band overscroll and a pull-to-refresh: both give a MORE negative
 * offset.
 *
 * Under a large title that top moves. The bar is tall at rest and shrinks as the
 * list scrolls, and JS hears its height a frame or more late (100 ms late where
 * the stack debounces it). Comparing against the height of the moment would turn
 * the blur on for a frame during the collapse, and again after a pull-to-refresh
 * stretched the bar. So the top that counts is the shallowest one seen: the top
 * under the bar at its shortest. Rows cannot be under the controls before the
 * title has finished collapsing anyway, because the controls move up with it.
 *
 * @param listKey Names the list the handler is wired to. A screen that swaps one
 * list for another under the same chrome (Profile's sub-tabs) passes a new key
 * with the new list, which mounts at rest whatever the last one was doing.
 */
export function useScrollEdgeBackdrop(listKey = ''): ScrollEdgeBackdrop {
  const listTopOffset = useListTopOffset();
  const [scrolledUnder, setScrolledUnder] = useState(false);
  const tracker = useRef<Tracker>({ offset: null, restingTop: listTopOffset, scrolledUnder: false });

  // A new list is at rest in the very render that mounts it: adjusting state while
  // rendering makes React start over before anything is drawn, where an effect
  // would let the old list's blur show for a frame over the new one.
  const [trackedListKey, setTrackedListKey] = useState(listKey);
  if (trackedListKey !== listKey) {
    setTrackedListKey(listKey);
    setScrolledUnder(false);
  }
  useEffect(() => {
    tracker.current.offset = null;
    tracker.current.scrolledUnder = false;
  }, [listKey]);

  // The one place a scroll sets state, and only when the answer changes: a scroll
  // event arrives every frame and must not re-render the screen that owns the list.
  const settle = useCallback(() => {
    const current = tracker.current;
    const next = current.offset !== null && current.offset > current.restingTop + SCROLL_EDGE_SLACK;
    if (next === current.scrolledUnder) return;
    current.scrolledUnder = next;
    setScrolledUnder(next);
  }, []);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      tracker.current.offset = event.nativeEvent.contentOffset.y;
      settle();
    },
    [settle],
  );

  // The bar's height can settle with no scroll event to follow it.
  useEffect(() => {
    const current = tracker.current;
    if (listTopOffset <= current.restingTop) return;
    current.restingTop = listTopOffset;
    settle();
  }, [listTopOffset, settle]);

  return { onScroll, scrolledUnder };
}
