import { useCallback, useMemo, useState } from 'react';
import { type LayoutChangeEvent } from 'react-native';
import { useRouter, useSegments } from 'expo-router';
import { Gesture, type ComposedGesture } from 'react-native-gesture-handler';
import { runOnJS, useAnimatedStyle, useSharedValue, type AnimatedStyle } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import { computeNavigationStateWithSuggestions } from '@boardsesh/play-view';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { useReduceMotion } from '../../hooks/use-reduce-motion';
import {
  useIsPartyPreviewOnly,
  usePlaylistSuggestionSource,
  useQueue,
  useQueueSessionId,
} from '../../providers/queue-provider';
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
  handlePrimaryPress: () => void;
  handleReturnToSession: () => void;
  returnToSessionAvailable: boolean;
  /** Return-to-session + prev/next exposed as a11y actions for hidden gestures. */
  swipeAccessibilityActions: AccessibilityAction[];
};

export function useQueueCarousel(): QueueCarousel {
  const { state, nextClimb, previousClimb } = useQueue();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  // Party non-drivers may only preview — stepping the current climb is a
  // shared-session mutation reserved for the driver. Mirrors PlayDrawer's
  // prev/next gating and the climb-list activation guard (784f2a823): the
  // always-visible bar is the one remaining ungated stepper, so a non-driver
  // swipe (or VoiceOver next/previous action) must NOT call nextClimb/
  // previousClimb and overwrite the driver's wall climb for everyone.
  const isPartyPreviewOnly = useIsPartyPreviewOnly();
  const { openPlayDrawer } = useDrawerHost();
  const { sessionId } = useQueueSessionId();
  const router = useRouter();
  const segments = useSegments();
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
  const nav = useMemo(
    () => computeNavigationStateWithSuggestions(queue, currentClimbQueueItem, playlistSuggestionSource),
    [queue, currentClimbQueueItem, playlistSuggestionSource],
  );
  const { nextItem, prevItem } = nav;
  // Preview-only members can't step the shared current climb, so the swipe and
  // a11y prev/next actions are disabled for them (matching the queue sheet's
  // precedent). The peek labels still render — non-drivers may *see* what's
  // next, they just can't commit it.
  const canPrevious = nav.canPrevious && !isPartyPreviewOnly;
  const canNext = nav.canNext && !isPartyPreviewOnly;

  const handleNext = useCallback(() => {
    if (isPartyPreviewOnly) return;
    hapticSelection();
    nextClimb();
  }, [isPartyPreviewOnly, nextClimb]);

  const handlePrevious = useCallback(() => {
    if (isPartyPreviewOnly) return;
    hapticSelection();
    previousClimb();
  }, [isPartyPreviewOnly, previousClimb]);

  const handleOpenPlay = useCallback(() => {
    if (!currentClimbQueueItem?.climb) return;
    hapticLight();
    // Opening the drawer for the already-current climb; opting out of
    // setAsCurrent avoids duplicating it at the end of the queue.
    openPlayDrawer(currentClimbQueueItem.climb, { setAsCurrent: false });
  }, [openPlayDrawer, currentClimbQueueItem]);

  const returnToSessionAvailable = sessionId !== null && !segments.includes('record');

  const handleReturnToSession = useCallback(() => {
    if (sessionId === null) return;
    hapticLight();
    router.navigate('/(tabs)/record');
  }, [router, sessionId]);

  const handlePrimaryPress = useCallback(() => {
    if (returnToSessionAvailable) {
      handleReturnToSession();
      return;
    }
    handleOpenPlay();
  }, [handleOpenPlay, handleReturnToSession, returnToSessionAvailable]);

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
          runOnJS(handlePrimaryPress)();
        }),
    [handlePrimaryPress],
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
  // Peek labels are hidden + parked off-screen at rest (translateX 0) and only
  // shown while a swipe/commit is in flight — so a stale or zero measured width
  // can never stack them on the current label. Mirrors SwipeBoardCarousel's
  // peekStyle guard. The offset math is inlined from computePeekOffset in
  // @boardsesh/play-view (cross-module worklet calls are avoided elsewhere too —
  // see clampTranslation in use-zoom-pan-gesture.ts); the shared fn stays the
  // canonical spec + test target. Reading widthSV/translateX directly here also
  // sidesteps the Android "derived value doesn't rebuild on width change" symptom.
  const nextPeekStyle = useAnimatedStyle(() => {
    if (translateX.value === 0) return { opacity: 0, transform: [{ translateX: widthSV.value }] };
    return { opacity: 1, transform: [{ translateX: Math.max(0, widthSV.value + translateX.value) }] };
  });
  const prevPeekStyle = useAnimatedStyle(() => {
    if (translateX.value === 0) return { opacity: 0, transform: [{ translateX: -widthSV.value }] };
    return { opacity: 1, transform: [{ translateX: Math.min(0, -widthSV.value + translateX.value) }] };
  });

  const swipeAccessibilityActions: AccessibilityAction[] = [
    ...(returnToSessionAvailable ? [{ name: 'returnToSession', label: t('mobile.queue.returnToSession') }] : []),
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
    handlePrimaryPress,
    handleReturnToSession,
    returnToSessionAvailable,
    swipeAccessibilityActions,
  };
}
