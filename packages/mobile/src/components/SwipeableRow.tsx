import { memo, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Pressable, View, StyleSheet, type AccessibilityActionEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import {
  Gesture,
  GestureDetector,
  type GestureUpdateEvent,
  type PanGestureHandlerEventPayload,
} from 'react-native-gesture-handler';
import { Icon } from './Icon';
import type { IconName } from './icon-map';
import { iosSystemColors } from '../theme/ios-colors';
import { hapticMedium } from '../lib/haptics';

const SWIPE_OPEN_THRESHOLD = -80;
const ACTION_BUTTON_WIDTH = 80;
const CLOSE_SPRING = { damping: 20, stiffness: 200 };

type SwipeableRowProps = {
  /** The row body. Its own press target should call through `onPress`. */
  children: ReactNode;
  /** Reveal-and-tap action (e.g. delete / unfollow). */
  onAction: () => void;
  actionLabel: string;
  /** Background colour of the revealed action (defaults to the system red). */
  actionColor?: string;
  actionIcon?: IconName;
  /** Tap on the row body (ignored while the swipe is open — that tap closes it). */
  onPress?: () => void;
  pressAccessibilityLabel?: string;
  /** When false, the swipe is disabled and any open swipe snaps shut. */
  enabled?: boolean;
  /**
   * Identity of the row's current data. FlashList recycles this component onto a
   * new item; when `resetKey` changes the swipe snaps shut so an open swipe can't
   * leak onto the recycled row.
   */
  resetKey?: string | number;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * A horizontally-swipeable row that reveals a single trailing destructive
 * action — the iOS swipe-to-delete idiom, distilled from `QueueItemRow` so list
 * screens can reuse it without re-deriving the gesture maths. Unlike
 * `QueueItemRow` it does NOT animate itself out on action: callers often gate the
 * action behind a confirm dialog, so the row must survive a cancel. On action it
 * snaps the swipe shut and fires `onAction`; the row disappears when the caller's
 * data refetch drops it. Callbacks are read through refs and the gesture is
 * memoised so the row can be wrapped in `React.memo` and skip list re-renders.
 */
function SwipeableRowComponent({
  children,
  onAction,
  actionLabel,
  actionColor = iosSystemColors.systemRed,
  actionIcon = 'delete',
  onPress,
  pressAccessibilityLabel,
  enabled = true,
  resetKey,
}: SwipeableRowProps) {
  const translateX = useSharedValue(0);
  const isSwipeOpen = useSharedValue(false);

  // Read the volatile callbacks through refs so a parent re-render that hands us
  // fresh `onAction`/`onPress` identities doesn't churn the memoised gesture.
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;

  // Snap shut when the swipe is disabled (e.g. a mutation starts on this row).
  useEffect(() => {
    if (!enabled) {
      translateX.value = withSpring(0, CLOSE_SPRING);
      isSwipeOpen.value = false;
    }
  }, [enabled, translateX, isSwipeOpen]);

  // Instant reset when this cell is recycled onto a different row (FlashList
  // reuses the instance), so an open swipe doesn't carry over to the new data.
  useEffect(() => {
    translateX.value = 0;
    isSwipeOpen.value = false;
  }, [resetKey, translateX, isSwipeOpen]);

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(enabled)
        .activeOffsetX([-10, 10])
        .failOffsetY([-5, 5])
        .onUpdate((event: GestureUpdateEvent<PanGestureHandlerEventPayload>) => {
          // Only allow swiping left.
          if (event.translationX > 0) {
            translateX.value = 0;
            return;
          }
          translateX.value = Math.max(event.translationX, -ACTION_BUTTON_WIDTH - 20);
        })
        .onEnd(() => {
          if (translateX.value < SWIPE_OPEN_THRESHOLD) {
            translateX.value = withSpring(-ACTION_BUTTON_WIDTH, CLOSE_SPRING);
            isSwipeOpen.value = true;
          } else {
            translateX.value = withSpring(0, CLOSE_SPRING);
            isSwipeOpen.value = false;
          }
        }),
    [enabled, translateX, isSwipeOpen],
  );

  const rowAnimatedStyle = useAnimatedStyle(() => ({ transform: [{ translateX: translateX.value }] }));
  const actionButtonStyle = useAnimatedStyle(() => {
    const width = Math.min(Math.abs(translateX.value), ACTION_BUTTON_WIDTH);
    return { width, opacity: width / ACTION_BUTTON_WIDTH };
  });

  const handlePress = useCallback(() => {
    // A tap with the action revealed closes it instead of activating the row.
    if (isSwipeOpen.value) {
      translateX.value = withSpring(0, CLOSE_SPRING);
      isSwipeOpen.value = false;
      return;
    }
    onPressRef.current?.();
  }, [translateX, isSwipeOpen]);

  const handleActionPress = useCallback(() => {
    hapticMedium();
    // Snap shut so a cancelled confirm leaves the row at rest; the caller's
    // refetch removes the row when the action actually commits.
    translateX.value = withSpring(0, CLOSE_SPRING);
    isSwipeOpen.value = false;
    onActionRef.current?.();
  }, [translateX, isSwipeOpen]);

  // The pan gesture is unreachable for VoiceOver/TalkBack, so expose the action
  // as an accessibility action on the row (the only way AT users can delete /
  // unfollow). Gated on `enabled` so it isn't offered mid-mutation.
  const handleAccessibilityAction = useCallback((event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === 'rowAction') onActionRef.current?.();
  }, []);

  const rowContent = (
    <AnimatedPressable
      onPress={handlePress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={pressAccessibilityLabel}
      accessibilityActions={enabled ? [{ name: 'rowAction', label: actionLabel }] : undefined}
      onAccessibilityAction={enabled ? handleAccessibilityAction : undefined}
      style={[styles.row, rowAnimatedStyle]}
    >
      {children}
    </AnimatedPressable>
  );

  return (
    <View style={styles.swipeContainer}>
      {enabled ? (
        <Animated.View style={[styles.action, { backgroundColor: actionColor }, actionButtonStyle]}>
          <Pressable
            onPress={handleActionPress}
            accessibilityRole="button"
            accessibilityLabel={actionLabel}
            style={styles.actionButton}
          >
            <Icon name={actionIcon} size={22} color={iosSystemColors.white} />
          </Pressable>
        </Animated.View>
      ) : null}

      {enabled ? <GestureDetector gesture={panGesture}>{rowContent}</GestureDetector> : rowContent}
    </View>
  );
}

export const SwipeableRow = memo(SwipeableRowComponent);

const styles = StyleSheet.create({
  swipeContainer: {
    flexDirection: 'row',
    alignItems: 'stretch',
    overflow: 'hidden',
  },
  row: {
    flex: 1,
  },
  action: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionButton: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
