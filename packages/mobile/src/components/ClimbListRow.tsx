import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useAnimatedReaction,
  interpolate,
  Extrapolation,
  runOnJS,
  type SharedValue,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import type { Climb, BoardName } from '@boardsesh/shared-schema';
import { Icon } from './Icon';
import { THUMBNAIL_WIDTH } from './ClimbListThumbnail';
import { ClimbListItemContent } from './ClimbListItemContent';
import { hapticLight, hapticMedium, hapticSuccess } from '../lib/haptics';
import { useTheme } from '../providers/theme-provider';
import { iosSystemColors } from '../theme/ios-colors';
import { brandColors } from '../theme/colors';
import { spacing } from '../theme/tokens';

// Swipe tuning. Each side reveals a panel up to ACTION_REVEAL wide; dragging
// past COMMIT_THRESHOLD and RELEASING commits the action (Spotify-style swipe-
// to-queue) — no resting-open state, no second tap. friction=1 makes the row
// track the finger 1:1 (snappy, like Spotify's tracklist swipe). Tunable.
const ACTION_REVEAL = 150;
const COMMIT_THRESHOLD = 96;
const SWIPE_FRICTION = 1;

/**
 * Leading "Queue" swipe action — Spotify-style commit-on-release (left-to-right
 * swipe). The panel shows a queue icon that flips to a "✓" once you cross the
 * commit threshold (with a haptic detent), so you feel and see that releasing
 * will queue the climb. The add fires from the row's onSwipeableWillOpen.
 */
function QueueSwipeAction({ translation }: { translation: SharedValue<number> }) {
  // Haptic detent the instant the drag crosses the commit threshold.
  useAnimatedReaction(
    () => Math.abs(translation.value) >= COMMIT_THRESHOLD,
    (armed, wasArmed) => {
      if (armed && !wasArmed) runOnJS(hapticLight)();
    },
  );
  const plusStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      Math.abs(translation.value),
      [COMMIT_THRESHOLD - 18, COMMIT_THRESHOLD],
      [1, 0],
      Extrapolation.CLAMP,
    ),
  }));
  const checkStyle = useAnimatedStyle(() => {
    const armedProgress = interpolate(
      Math.abs(translation.value),
      [COMMIT_THRESHOLD - 8, COMMIT_THRESHOLD + 6],
      [0, 1],
      Extrapolation.CLAMP,
    );
    return { opacity: armedProgress, transform: [{ scale: 0.6 + armedProgress * 0.4 }] };
  });
  return (
    <View style={[styles.swipeAction, styles.queueAction]}>
      <View style={styles.swipeIcon}>
        <Animated.View style={[styles.swipeIconLayer, plusStyle]}>
          <Icon name="queue" size={26} color={iosSystemColors.white} />
        </Animated.View>
        <Animated.View style={[styles.swipeIconLayer, checkStyle]}>
          <Icon name="tick" size={26} color={iosSystemColors.white} />
        </Animated.View>
      </View>
    </View>
  );
}

/**
 * Trailing "Playlist" swipe action (right-to-left swipe) — commit-on-release
 * opens the playlist picker. Rose panel with a playlist icon that grows in with
 * the drag plus a haptic detent at the threshold; the picker opens from
 * onSwipeableWillOpen.
 */
function PlaylistSwipeAction({ translation }: { translation: SharedValue<number> }) {
  useAnimatedReaction(
    () => Math.abs(translation.value) >= COMMIT_THRESHOLD,
    (armed, wasArmed) => {
      if (armed && !wasArmed) runOnJS(hapticLight)();
    },
  );
  const iconStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.abs(translation.value) / (COMMIT_THRESHOLD * 0.35)),
    transform: [
      { scale: interpolate(Math.abs(translation.value), [0, COMMIT_THRESHOLD], [0.6, 1], Extrapolation.CLAMP) },
    ],
  }));
  return (
    <View style={[styles.swipeAction, styles.playlistAction]}>
      <Animated.View style={iconStyle}>
        <Icon name="playlist" size={24} color={iosSystemColors.white} />
      </Animated.View>
    </View>
  );
}

type ClimbListRowProps = {
  climb: Climb;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  onPress: (climb: Climb) => void;
  onAddToQueue?: (climb: Climb) => void;
  onOpenPlaylist?: (climb: Climb) => void;
  onOpenActions?: (climb: Climb) => void;
  selected?: boolean;
  unsupported?: boolean;
};

const ClimbListRow = React.memo(function ClimbListRow({
  climb,
  boardName,
  layoutId,
  sizeId,
  setIds,
  angle,
  onPress,
  onAddToQueue,
  onOpenPlaylist,
  onOpenActions,
  selected,
  unsupported,
}: ClimbListRowProps) {
  const { systemColors } = useTheme();

  const swipeableRef = useRef<SwipeableMethods>(null);

  // FlashList recycles rows (same instance, new climb). Snap any open swipe
  // shut so a recycled row never shows the previous climb's open panel.
  // reset() (vs close()) skips the animation — an animated slide-shut on a
  // recycle would read as a glitch. The reset lands on the next UI frame, so a
  // row recycled mid-swipe can flash its panel for ~1 frame; the opaque
  // contentRow background occludes the panel once translation returns to 0, so
  // that background must stay opaque.
  useEffect(() => {
    swipeableRef.current?.reset();
  }, [climb.uuid]);

  // Stable refs so gesture/worklet callbacks never close over stale props.
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;
  const onAddToQueueRef = useRef(onAddToQueue);
  onAddToQueueRef.current = onAddToQueue;
  const onOpenPlaylistRef = useRef(onOpenPlaylist);
  onOpenPlaylistRef.current = onOpenPlaylist;
  const onOpenActionsRef = useRef(onOpenActions);
  onOpenActionsRef.current = onOpenActions;
  const climbRef = useRef(climb);
  climbRef.current = climb;
  const unsupportedRef = useRef(unsupported);
  unsupportedRef.current = unsupported;

  const handleRowPress = useCallback(() => {
    if (unsupportedRef.current) return;
    hapticLight();
    onPressRef.current(climbRef.current);
  }, []);

  const handleLongPress = useCallback(() => {
    if (unsupportedRef.current) return;
    hapticMedium();
    onOpenActionsRef.current?.(climbRef.current);
  }, []);

  // Commit-on-release: fired from onSwipeableWillOpen the instant the user
  // releases past the threshold — no second tap. We deliberately do NOT close
  // here: closing mid-"will open" raced ReanimatedSwipeable's open animation
  // and left its open/closed state machine out of sync, so only every OTHER
  // swipe fired willOpen. The row finishes opening and is snapped shut from
  // onSwipeableOpen (handleSwipeableOpened) instead — a clean closed→open→
  // closed cycle that fires on every swipe.
  const handleAddToQueue = useCallback(() => {
    hapticSuccess();
    onAddToQueueRef.current?.(climbRef.current);
  }, []);

  const handleOpenPlaylist = useCallback(() => {
    hapticMedium();
    onOpenPlaylistRef.current?.(climbRef.current);
  }, []);

  // Snap the row shut once it has fully settled open. Runs after the action
  // already fired on willOpen, so the user sees an instant commit and the row
  // springs back.
  const handleSwipeableOpened = useCallback(() => {
    swipeableRef.current?.close();
  }, []);

  const handleSwipeWillOpen = useCallback(
    (direction: 'left' | 'right') => {
      // ReanimatedSwipeable reports the SWIPE direction, not the actions side:
      // 'right' fires when the LEFT actions (Queue) open (left-to-right swipe);
      // 'left' fires when the RIGHT actions (Playlist) open (right-to-left).
      if (direction === 'right') handleAddToQueue();
      else handleOpenPlaylist();
    },
    [handleAddToQueue, handleOpenPlaylist],
  );

  const singleTapGesture = useMemo(
    () =>
      Gesture.Tap()
        .maxDuration(300)
        .maxDistance(15)
        .onStart(() => {
          'worklet';
          runOnJS(handleRowPress)();
        }),
    [handleRowPress],
  );

  const longPressGesture = useMemo(
    () =>
      Gesture.LongPress()
        .minDuration(400)
        .onStart(() => {
          'worklet';
          runOnJS(handleLongPress)();
        }),
    [handleLongPress],
  );

  // Long-press wins over tap; a quick tap fires once the long-press fails.
  const tapGesture = useMemo(
    () => Gesture.Exclusive(longPressGesture, singleTapGesture),
    [longPressGesture, singleTapGesture],
  );

  // Left actions (revealed by a left-to-right swipe) = Queue; right actions
  // (right-to-left swipe) = Playlist.
  const renderLeftActions = useCallback(
    (_progress: SharedValue<number>, translation: SharedValue<number>) => (
      <QueueSwipeAction translation={translation} />
    ),
    [],
  );
  const renderRightActions = useCallback(
    (_progress: SharedValue<number>, translation: SharedValue<number>) => (
      <PlaylistSwipeAction translation={translation} />
    ),
    [],
  );

  return (
    <View style={[styles.outerContainer, unsupported && styles.unsupported]}>
      <ReanimatedSwipeable
        ref={swipeableRef}
        friction={SWIPE_FRICTION}
        leftThreshold={COMMIT_THRESHOLD}
        rightThreshold={COMMIT_THRESHOLD}
        overshootLeft={false}
        overshootRight={false}
        renderLeftActions={renderLeftActions}
        renderRightActions={renderRightActions}
        onSwipeableWillOpen={handleSwipeWillOpen}
        onSwipeableOpen={handleSwipeableOpened}
      >
        <GestureDetector gesture={tapGesture}>
          <View
            style={[styles.contentRow, { backgroundColor: systemColors.background }]}
            accessible
            accessibilityRole="button"
            accessibilityLabel={climb.name}
            accessibilityState={{ selected: !!selected }}
          >
            {/* Active-climb highlight: rose wash + left accent bar */}
            {selected ? <View style={styles.selectedFill} pointerEvents="none" /> : null}
            {selected ? <View style={styles.selectedAccent} pointerEvents="none" /> : null}

            <ClimbListItemContent
              climb={climb}
              boardName={boardName}
              layoutId={layoutId}
              sizeId={sizeId}
              setIds={setIds}
              angle={angle}
            />
          </View>
        </GestureDetector>
      </ReanimatedSwipeable>

      {/* Separator — inset to start at the text column (after the thumbnail) */}
      <View style={[styles.separator, { backgroundColor: systemColors.separator }]} />
    </View>
  );
});

export { ClimbListRow };

const styles = StyleSheet.create({
  outerContainer: {
    position: 'relative',
    overflow: 'hidden',
  },
  unsupported: {
    opacity: 0.5,
  },
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing[2],
    paddingVertical: spacing[2],
    gap: spacing[3],
  },
  // Active-climb wash. Brand rose (#8C4A52) — kept distinct from the grade
  // colour on the right of the row. Behind the content (crisp text). Bumped
  // from 0.14 → 0.18 so it reads on near-black OLED, where the accent bar
  // scrolls off during a swipe and the wash is the only state cue left.
  selectedFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(140, 74, 82, 0.18)',
  },
  selectedAccent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 5,
    backgroundColor: brandColors.primary,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: THUMBNAIL_WIDTH + spacing[2] + spacing[3],
  },
  swipeAction: {
    width: ACTION_REVEAL,
    justifyContent: 'center',
  },
  // Pin each icon to the OUTER edge of its panel (queue = right/screen edge,
  // playlist = left/screen edge) so it appears as soon as the panel starts
  // revealing, instead of needing half the panel out to see a centred icon.
  queueAction: {
    backgroundColor: brandColors.success,
    alignItems: 'flex-start',
    paddingLeft: 22,
  },
  playlistAction: {
    backgroundColor: brandColors.primary,
    alignItems: 'flex-end',
    paddingRight: 22,
  },
  swipeIcon: {
    width: 28,
    height: 28,
  },
  swipeIconLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
