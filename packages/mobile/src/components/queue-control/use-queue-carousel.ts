import { useCallback, useMemo, useState } from 'react';
import { type LayoutChangeEvent } from 'react-native';
import { Gesture, type ComposedGesture } from 'react-native-gesture-handler';
import {
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  type AnimatedStyle,
} from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { computePeekOffset, computeNavigationStateWithSuggestions } from '@boardsesh/play-view';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import { usePlaylistSuggestionSource, useQueue } from '../../providers/queue-provider';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { hapticLight, hapticSelection } from '../../lib/haptics';
import { useCarouselGesture } from '../play-drawer/use-carousel-gesture';

type AccessibilityAction = { name: string; label: string };

/**
 * The shared "current climb" carousel behind the floating queue capsule
 * (`ClimbCapsule`) and the iOS 26 native bottom accessory
 * (`NativeAccessoryClimbRow`). Both surfaces show name + grade with the same
 * swipe-to-step / swipe-up-to-open / tap-to-open interaction and the neighbouring
 * climb peeking in — this hook owns all of that (queue navigation, gesture
 * composition, peek animation, a11y actions) so the two presentational wrappers
 * keep only their own labels and chrome.
 */
export type QueueCarousel = {
  /** Measure the swipe viewport so the peek offsets are width-relative. */
  onLayout: (event: LayoutChangeEvent) => void;
  /** Tap (open) ∪ swipe-up (open) ∪ horizontal pan (prev/next). */
  composedGesture: ComposedGesture;
  currentLabelStyle: AnimatedStyle;
  nextPeekStyle: AnimatedStyle;
  prevPeekStyle: AnimatedStyle;
  currentItem: ClimbQueueItem | null | undefined;
  previousItem: ClimbQueueItem | null | undefined;
  nextItem: ClimbQueueItem | null | undefined;
  /** Peek slots may render: the viewport has been measured (width > 0). Until
   *  then the peeks would resolve to translateX 0 and stack on the current label. */
  canPeek: boolean;
  canPrevious: boolean;
  canNext: boolean;
  handleNext: () => void;
  handlePrevious: () => void;
  /** Prev/next exposed as a11y actions (swipe is invisible to VoiceOver). */
  swipeAccessibilityActions: AccessibilityAction[];
};

export function useQueueCarousel(): QueueCarousel {
  const { state, nextClimb, previousClimb } = useQueue();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  const { openPlayDrawer } = useDrawerHost();
  const { t } = useTranslation('session');
  const reduceMotion = useReduceMotion();

  const [width, setWidth] = useState(0);
  // Mirror the measured viewport width into a shared value so the peek-offset
  // worklets read it on the UI thread instead of capturing the React-state
  // primitive. On Android's new architecture the derived-value worklet does not
  // reliably rebuild when `width` updates from its initial 0, which left the
  // peeks stuck at translateX 0 (stacked on the current label). Same pattern as
  // `boardWidthSV` in use-carousel-gesture.ts.
  const widthSV = useSharedValue(0);
  const { currentClimbQueueItem, queue } = state;

  // Suggestion-aware so the capsule carousel matches the play drawer: at the
  // queue tail of an active playlist, `nextItem` falls through to the next
  // playlist climb (a transient "peek") instead of stopping. canPrevious/prevItem
  // stay queue-only — there is no backward suggestion fall-through.
  const { canPrevious, canNext, nextItem, prevItem } = useMemo(
    () => computeNavigationStateWithSuggestions(queue, currentClimbQueueItem, playlistSuggestionSource),
    [queue, currentClimbQueueItem, playlistSuggestionSource],
  );

  const handleNext = useCallback(() => {
    hapticSelection();
    nextClimb();
  }, [nextClimb]);

  const handlePrevious = useCallback(() => {
    hapticSelection();
    previousClimb();
  }, [previousClimb]);

  const handleOpenPlay = useCallback(() => {
    if (!currentClimbQueueItem?.climb) return;
    hapticLight();
    // Opening the drawer for the already-current climb; opting out of
    // setAsCurrent avoids duplicating it at the end of the queue.
    openPlayDrawer(currentClimbQueueItem.climb, { setAsCurrent: false });
  }, [openPlayDrawer, currentClimbQueueItem]);

  const { gesture: panGesture, translateX } = useCarouselGesture({
    onSwipeNext: handleNext,
    onSwipePrevious: handlePrevious,
    canSwipeNext: canNext,
    canSwipePrevious: canPrevious,
    boardWidth: width,
    enabled: width > 0,
    reduceMotion,
  });

  const tapGesture = useMemo(
    () =>
      Gesture.Tap()
        .maxDuration(250)
        .onEnd(() => {
          'worklet';
          runOnJS(handleOpenPlay)();
        }),
    [handleOpenPlay],
  );

  // Swipe up to open the drawer — a quick alternative to tapping (like dragging a
  // now-playing chip up to full screen). Activates only on upward movement and
  // bails on horizontal travel, so the prev/next carousel keeps the sideways
  // swipes. Opens on a decisive drag or a fast upward flick.
  const swipeUpGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(-12)
        .failOffsetX([-20, 20])
        .onEnd((event) => {
          'worklet';
          if (event.translationY < -40 || event.velocityY < -600) {
            runOnJS(handleOpenPlay)();
          }
        }),
    [handleOpenPlay],
  );

  const composedGesture = useMemo(
    () => Gesture.Race(panGesture, swipeUpGesture, tapGesture),
    [panGesture, swipeUpGesture, tapGesture],
  );

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const measured = event.nativeEvent.layout.width;
      setWidth(measured);
      widthSV.value = measured;
    },
    [widthSV],
  );

  const currentLabelStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));
  const nextPeekX = useDerivedValue(() =>
    computePeekOffset({ direction: 'next', swipeOffset: translateX.value, viewportWidth: widthSV.value }),
  );
  const prevPeekX = useDerivedValue(() =>
    computePeekOffset({ direction: 'prev', swipeOffset: translateX.value, viewportWidth: widthSV.value }),
  );
  const nextPeekStyle = useAnimatedStyle(() => ({ transform: [{ translateX: nextPeekX.value }] }));
  const prevPeekStyle = useAnimatedStyle(() => ({ transform: [{ translateX: prevPeekX.value }] }));

  const swipeAccessibilityActions: AccessibilityAction[] = [
    ...(canPrevious ? [{ name: 'previous', label: t('mobile.queue.previousClimb') }] : []),
    ...(canNext ? [{ name: 'next', label: t('mobile.queue.nextClimb') }] : []),
  ];

  return {
    onLayout,
    composedGesture,
    currentLabelStyle,
    nextPeekStyle,
    prevPeekStyle,
    currentItem: currentClimbQueueItem,
    previousItem: prevItem,
    nextItem,
    canPeek: width > 0,
    canPrevious,
    canNext,
    handleNext,
    handlePrevious,
    swipeAccessibilityActions,
  };
}
