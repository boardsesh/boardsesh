import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

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
  /** The climber dragged or flung the list since the last `reset`. */
  hasScrolled: () => boolean;
  /** Start a new window: the next `hasScrolled` needs a new drag or fling. */
  reset: () => void;
};

/**
 * Tells a list moved by the climber from one moved by code or by layout.
 *
 * A drag or the momentum after it counts, and so does every scroll event while
 * either is under way, so a fling still counts after `reset` until it stops. A
 * scroll event with no gesture behind it (`scrollToOffset`, a content-size
 * change, a remount) does not.
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

  return {
    handlers: {
      onScroll: (event) => {
        if (dragging || coasting) scrolled = true;
        getForward()?.onScroll?.(event);
      },
      onScrollBeginDrag: (event) => {
        dragging = true;
        // A finger down ends whatever was coasting.
        coasting = false;
        scrolled = true;
        getForward()?.onScrollBeginDrag?.(event);
      },
      onScrollEndDrag: (event) => {
        dragging = false;
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
    },
  };
}
