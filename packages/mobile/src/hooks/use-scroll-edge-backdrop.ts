import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

/**
 * Points a list must travel past its resting top before its rows count as being
 * under the controls. Absorbs sub-point offsets and the last frame of a bounce.
 */
export const SCROLL_EDGE_SLACK = 2;

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

/**
 * Spread onto the list. None of them sets React state. The last two take no
 * argument because they read none: a handler with fewer parameters is still
 * assignable to React Native's `(event) => void` props.
 */
export type ScrollEdgeListProps = {
  onScroll: (event: ScrollEvent) => void;
  onScrollBeginDrag: (event: ScrollEvent) => void;
  onScrollEndDrag: (event: ScrollEvent) => void;
  onMomentumScrollBegin: () => void;
  onMomentumScrollEnd: () => void;
};

/**
 * Whether a root tab's list has scrolled under the controls pinned below the
 * bar, so the blur behind them shows only then. The system's own scroll edge
 * effect behaves this way: at rest the page is the page.
 *
 * A store, not React state, because three parties meet here and only one of
 * them should re-render:
 *
 *   - the list reports its scrolling (`listProps`), every frame;
 *   - the chrome reports where it drew the controls (`setTopOffset`), every time
 *     the bar's height changes;
 *   - the blur subscribes to the answer (`useScrolledUnder`), which changes when
 *     rows cross the controls' bottom edge and at no other time.
 *
 * The screen that owns the list holds the store and hears none of it.
 */
export type ScrollEdgeBackdrop = {
  readonly listProps: ScrollEdgeListProps;
  /** The list is new, or gone: nothing is under the controls until it scrolls. */
  resetList: () => void;
  /**
   * The list offset at which the first row sits exactly at the controls' bottom
   * edge, as the chrome last drew them: minus the bar's height under a UIKit
   * header, 0 where there is none.
   */
  setTopOffset: (topOffset: number) => void;
  /** A blur is mounted and listening. Returns its detach. */
  attachBackdrop: () => () => void;
  subscribe: (listener: () => void) => () => void;
  isScrolledUnder: () => boolean;
  hasBackdrop: () => boolean;
};

/**
 * The rule is geometry: rows are under the controls once the list's offset is
 * past the top the chrome drew them at. Anything at or above that top is at
 * rest, which covers the rubber-band overscroll and a pull-to-refresh: both
 * give a MORE negative offset.
 *
 * Two things bend it, both because JS hears the bar's height late (a frame or
 * two, or 100 ms after it stops where the stack debounces it):
 *
 *   - A bar that GROWS during a gesture never moves the top down. A pull
 *     stretches the bar and JS can still hold the stretched height after the
 *     list has snapped back, which would read as "scrolled" at rest. So each
 *     gesture keeps the top it started with as a ceiling.
 *
 *   - A bar that SHRINKS during a gesture which began at rest is ignored until
 *     the gesture ends. Under a collapsing large title the controls are meant
 *     to ride up with the title, but they trail it, and a row that has left
 *     rest is under them. Following the height as it arrives would flip the
 *     answer back and forth every frame. So once such a gesture has left rest,
 *     the blur is on until the list stops; then the settled height decides.
 */
export function createScrollEdgeBackdrop(): ScrollEdgeBackdrop {
  const listeners = new Set<() => void>();
  let backdrops = 0;
  let scrolledUnder = false;
  /** Where the chrome last drew the controls' bottom edge, as a list offset. */
  let topOffset = 0;
  /** The list's last reported offset; null until it has scrolled at all. */
  let offset: number | null = null;
  /** `topOffset` when the current (or last) gesture began: its ceiling. */
  let gestureTopOffset: number | null = null;
  /** That gesture began with the list at rest, not already scrolled under. */
  let gestureBeganAtRest = false;
  let dragging = false;
  let coasting = false;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const settle = () => {
    let top = topOffset;
    if (gestureTopOffset !== null) {
      const inFlightFromRest = gestureBeganAtRest && (dragging || coasting);
      top = inFlightFromRest ? gestureTopOffset : Math.max(topOffset, gestureTopOffset);
    }
    const next = offset !== null && offset > top + SCROLL_EDGE_SLACK;
    if (next === scrolledUnder) return;
    scrolledUnder = next;
    notify();
  };

  const listProps: ScrollEdgeListProps = {
    onScroll: (event) => {
      offset = event.nativeEvent.contentOffset.y;
      settle();
    },
    onScrollBeginDrag: (event) => {
      offset = event.nativeEvent.contentOffset.y;
      gestureTopOffset = topOffset;
      gestureBeganAtRest = offset <= topOffset + SCROLL_EDGE_SLACK;
      dragging = true;
      // A finger down ends whatever was coasting, whether or not its end event
      // has arrived yet.
      coasting = false;
      settle();
    },
    onScrollEndDrag: (event) => {
      dragging = false;
      // The lift arrives before momentum begins. UIKit's projected target
      // distinguishes a fling from a nonzero velocity stopped at a bound,
      // where no momentum-end event follows. Older event variants omit it.
      const { contentOffset, targetContentOffset, velocity } = event.nativeEvent;
      coasting = targetContentOffset ? targetContentOffset.y !== contentOffset.y : (velocity?.y ?? 0) !== 0;
      settle();
    },
    onMomentumScrollBegin: () => {
      coasting = true;
      settle();
    },
    onMomentumScrollEnd: () => {
      coasting = false;
      settle();
    },
  };

  return {
    listProps,
    resetList: () => {
      offset = null;
      gestureTopOffset = null;
      gestureBeganAtRest = false;
      dragging = false;
      coasting = false;
      settle();
    },
    setTopOffset: (next) => {
      if (next === topOffset) return;
      topOffset = next;
      settle();
    },
    attachBackdrop: () => {
      backdrops += 1;
      if (backdrops === 1) notify();
      return () => {
        backdrops -= 1;
        if (backdrops === 0) notify();
      };
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isScrolledUnder: () => scrolledUnder,
    hasBackdrop: () => backdrops > 0,
  };
}

/**
 * For the screen that owns the list. `backdrop` goes to the top chrome. `list`
 * goes to the list, and is undefined until a blur is mounted to hear it, so a
 * list under an opaque header (Material, Android, iOS before 26, Reduce
 * Transparency, Increase Contrast) carries no scroll listeners at all.
 *
 * The screen re-renders when a blur mounts or unmounts, and never for a scroll
 * or a change in the bar's height.
 */
export function useScrollEdgeBackdrop(): { backdrop: ScrollEdgeBackdrop; list: ScrollEdgeBackdrop | undefined } {
  const [backdrop] = useState(createScrollEdgeBackdrop);
  const listening = useSyncExternalStore(backdrop.subscribe, backdrop.hasBackdrop, backdrop.hasBackdrop);
  return { backdrop, list: listening ? backdrop : undefined };
}

const subscribeToNothing = () => () => {};
const alwaysScrolledUnder = () => true;

/**
 * For the blur. With no store the answer is always yes: chrome that was never
 * wired to a list keeps its blur on, which shows as a frost at rest and is plain
 * to see, where the other default would put bare controls over rows mid-scroll.
 */
export function useScrolledUnder(backdrop: ScrollEdgeBackdrop | undefined): boolean {
  const getSnapshot = backdrop ? backdrop.isScrolledUnder : alwaysScrolledUnder;
  return useSyncExternalStore(backdrop ? backdrop.subscribe : subscribeToNothing, getSnapshot, getSnapshot);
}

/**
 * Renders nothing. Mount it beside the list, in the branch that renders the
 * list. A list that mounts is at rest, and one that unmounts (a loading or
 * offline branch takes its place, another sub-tab's list does) leaves nothing
 * under the controls. Without it the last list's answer would outlive the list
 * and leave the blur on over an empty page.
 *
 * A layout effect, so the blur is told before the frame that swaps the list.
 */
export function ScrollEdgeListReset({ edge }: { edge: ScrollEdgeBackdrop | undefined }) {
  useLayoutEffect(() => {
    if (!edge) return undefined;
    edge.resetList();
    return edge.resetList;
  }, [edge]);
  return null;
}
