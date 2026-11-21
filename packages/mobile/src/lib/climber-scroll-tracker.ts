import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

/**
 * How far the list has to move, in points, to count as the climber scrolling
 * when no drag or fling is behind it. Large enough to ignore an inset or
 * content-size nudge, small enough that one VoiceOver or TalkBack page step, or
 * one mouse-wheel notch, clears it.
 */
export const CLIMBER_SCROLL_MIN_DISTANCE = 24;

/** The scroll callbacks a list forwards to; any of them may be missing. */
export type ForwardedScrollHandlers = {
  onScroll?: (event: ScrollEvent) => void;
  onScrollBeginDrag?: (event: ScrollEvent) => void;
  onScrollEndDrag?: (event: ScrollEvent) => void;
  onMomentumScrollBegin?: () => void;
  onMomentumScrollEnd?: () => void;
};

export type ClimberScrollTracker = {
  /** Spread onto the list in place of the handlers it wraps. */
  handlers: Required<ForwardedScrollHandlers>;
  /** The climber scrolled the list since the last `reset`. */
  hasScrolled: () => boolean;
  /**
   * Start a new window: the next `hasScrolled` needs a new drag or fling, or the
   * list moving on from where it is now. A gesture still under way counts again
   * with its next scroll event.
   */
  reset: () => void;
  /**
   * `reset`, and forget any gesture under way and where the list was. For when
   * a gesture's end event will never arrive: a new search scrolled the list to
   * the top mid-fling, or the list was remounted.
   */
  forgetGesture: () => void;
};

/**
 * Tells a list the climber scrolled from one that only laid out.
 *
 * Two things count:
 *
 * - A drag or the momentum after it, and every scroll event while either is
 *   under way, so a drag or fling still counts after `reset` until it stops.
 * - The list moving `CLIMBER_SCROLL_MIN_DISTANCE` or more from where it was at
 *   the last `reset`, with or without a gesture. VoiceOver and TalkBack scroll
 *   actions, focus following, a mouse wheel and a keyboard never send a drag.
 *
 * Rows that lay out at zero height (the page drain this guards) never move the
 * list, so neither counts for them. The first scroll event after a
 * `forgetGesture` only records where the list is.
 *
 * `getForward` is read on every event, so the handlers it returns can change
 * without the tracker being rebuilt.
 */
export function createClimberScrollTracker(
  getForward: () => ForwardedScrollHandlers | undefined,
): ClimberScrollTracker {
  let scrolled = false;
  let dragging = false;
  let coasting = false;
  /** The list's last reported offset; null until it reports one. */
  let latestOffset: number | null = null;
  /** Where the list was at the last `reset`; null until one is known. */
  let offsetAtReset: number | null = null;

  const recordOffset = (event: ScrollEvent) => {
    const offset = event.nativeEvent.contentOffset.y;
    latestOffset = offset;
    if (offsetAtReset === null) offsetAtReset = offset;
    else if (Math.abs(offset - offsetAtReset) >= CLIMBER_SCROLL_MIN_DISTANCE) scrolled = true;
  };

  return {
    handlers: {
      onScroll: (event) => {
        if (dragging || coasting) scrolled = true;
        recordOffset(event);
        getForward()?.onScroll?.(event);
      },
      onScrollBeginDrag: (event) => {
        dragging = true;
        // A finger down ends whatever was coasting.
        coasting = false;
        scrolled = true;
        recordOffset(event);
        getForward()?.onScrollBeginDrag?.(event);
      },
      onScrollEndDrag: (event) => {
        dragging = false;
        recordOffset(event);
        getForward()?.onScrollEndDrag?.(event);
      },
      onMomentumScrollBegin: () => {
        coasting = true;
        scrolled = true;
        getForward()?.onMomentumScrollBegin?.();
      },
      onMomentumScrollEnd: () => {
        coasting = false;
        getForward()?.onMomentumScrollEnd?.();
      },
    },
    hasScrolled: () => scrolled,
    reset: () => {
      scrolled = false;
      offsetAtReset = latestOffset;
    },
    forgetGesture: () => {
      scrolled = false;
      dragging = false;
      coasting = false;
      latestOffset = null;
      offsetAtReset = null;
    },
  };
}
