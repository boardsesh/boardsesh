import React, { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { View, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
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
import { ClimbListItemContent } from './ClimbListItemContent';
import { climbListRowStyles } from './climb-list-row-styles';
import { hapticLight, hapticMedium, hapticSuccess } from '../lib/haptics';
import { useTheme } from '../providers/theme-provider';
import { iosSystemColors } from '../theme/ios-colors';
import { brandColors } from '../theme/colors';
import { selectedRowColors } from './climb-list-row-colors';
import { useSwipeArm } from './use-swipe-arm';

// Swipe tuning. Each side reveals a panel up to ACTION_REVEAL wide; dragging
// past COMMIT_THRESHOLD and RELEASING commits the action (Spotify-style swipe-
// to-queue) — no resting-open state, no second tap. friction=1 makes the row
// track the finger 1:1 (snappy, like Spotify's tracklist swipe). Tunable.
const ACTION_REVEAL = 150;
const COMMIT_THRESHOLD = 96;
const SWIPE_FRICTION = 1;

// Per-row swipe perf: the panels below split into a cheap always-mounted shell
// (just the coloured panel + its resting-state icon, zero shared values /
// animated styles / reactions) and a heavy animated inner that carries the
// drag-driven icon interpolation + haptic-detent reaction. FlashList recycles
// rows, so when a row is just sitting in the list the shell is all that mounts.
// The inner mounts lazily the instant a horizontal drag begins (`active`), so
// the animated cost is paid only while the user is actually swiping — not on
// every recycle during a scroll. The shell renders each panel's translation=0
// appearance, so the lazy inner can mount a frame or two late without ever
// showing a blank or wrong-looking panel: the panel is occluded by the opaque
// row at rest and only the first frames of a drag are covered by the shell,
// which already looks identical to the inner at translation≈0.

/**
 * Drag-driven inner of the "Queue" action. The queue icon flips to a "✓" once
 * you cross the commit threshold (with a haptic detent), so you feel and see
 * that releasing will queue the climb. Only mounted while the row is being
 * dragged; the add itself still fires from the row's onSwipeableWillOpen.
 */
function QueueSwipeActionInner({ translation }: { translation: SharedValue<number> }) {
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
    <View style={styles.swipeIcon}>
      <Animated.View style={[styles.swipeIconLayer, plusStyle]}>
        <Icon name="queue" size={26} color={iosSystemColors.white} />
      </Animated.View>
      <Animated.View style={[styles.swipeIconLayer, checkStyle]}>
        <Icon name="tick" size={26} color={iosSystemColors.white} />
      </Animated.View>
    </View>
  );
}

/**
 * Leading "Queue" swipe action — Spotify-style commit-on-release (left-to-right
 * swipe). Cheap shell while resting; mounts the animated inner once a drag
 * starts (`active`). The resting shell shows the queue icon at full opacity (the
 * translation=0 state, where the "✓" is fully transparent), so the panel looks
 * right from the first frame of a drag.
 */
function QueueSwipeAction({ translation, active }: { translation: SharedValue<number>; active: boolean }) {
  return (
    <View style={[styles.swipeAction, styles.queueAction]}>
      {active ? (
        <QueueSwipeActionInner translation={translation} />
      ) : (
        <View style={styles.swipeIcon}>
          <View style={styles.swipeIconLayer}>
            <Icon name="queue" size={26} color={iosSystemColors.white} />
          </View>
        </View>
      )}
    </View>
  );
}

/**
 * Drag-driven inner of the "Playlist" action — playlist icon grows in with the
 * drag plus a haptic detent at the threshold. Only mounted while the row is
 * being dragged; the picker still opens from the row's onSwipeableWillOpen.
 */
function PlaylistSwipeActionInner({ translation }: { translation: SharedValue<number> }) {
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
    <Animated.View style={iconStyle}>
      <Icon name="playlist" size={24} color={iosSystemColors.white} />
    </Animated.View>
  );
}

/**
 * Trailing "Playlist" swipe action (right-to-left swipe) — commit-on-release
 * opens the playlist picker. Cheap shell while resting; mounts the animated
 * inner once a drag starts (`active`). At translation=0 the playlist icon is
 * fully transparent, so the resting shell deliberately renders no icon — the
 * panel matches the inner's first frame.
 */
function PlaylistSwipeAction({ translation, active }: { translation: SharedValue<number>; active: boolean }) {
  return (
    <View style={[styles.swipeAction, styles.playlistAction]}>
      {active ? <PlaylistSwipeActionInner translation={translation} /> : null}
    </View>
  );
}

export type ClimbListRowRenderContentArgs = {
  climb: Climb;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

type ClimbListRowProps = {
  climb: Climb;
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  onPress?: (climb: Climb) => void;
  onAddToQueue?: (climb: Climb) => void;
  onOpenPlaylist?: (climb: Climb) => void;
  onOpenActions?: (climb: Climb) => void;
  selected?: boolean;
  unsupported?: boolean;
  renderContent?: (args: ClimbListRowRenderContentArgs) => ReactNode;
  containerStyle?: StyleProp<ViewStyle>;
  contentRowStyle?: StyleProp<ViewStyle>;
  separatorStyle?: StyleProp<ViewStyle>;
  showSeparator?: boolean;
  /** Diagnostic (preview/dev only): render the row WITHOUT the ReanimatedSwipeable
   *  wrapper, to test whether the per-row horizontal-pan gesture is stealing the
   *  list's vertical scroll on Android 16. Default false. See freeze-debug-store. */
  disableSwipe?: boolean;
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
  renderContent,
  containerStyle,
  contentRowStyle,
  separatorStyle,
  showSeparator = true,
  disableSwipe = false,
}: ClimbListRowProps) {
  const { systemColors, brandColors: brand } = useTheme();
  // Active-row highlight colours, derived from the scheme-aware brand so the wash
  // + accent stay visible in dark (lifted #A78BFA) as well as light.
  const highlight = useMemo(() => selectedRowColors(brand.primary), [brand.primary]);

  const swipeableRef = useRef<SwipeableMethods>(null);

  // Lazy swipe panels: the heavy animated action content (icon interpolation +
  // haptic-detent reaction) only mounts once a drag actually starts on THIS
  // row. While the row is just sitting in the list — the common case during a
  // scroll — only the cheap panel shells mount. The hook resets the machine on
  // recycle (climb.uuid) and exposes a ref so the render callbacks below can
  // read the live value without taking it as a dep (see useSwipeArm for why).
  const { armedRef: dragArmedRef, arm, disarm } = useSwipeArm(climb.uuid);

  // FlashList recycles rows (same instance, new climb). Snap any open swipe
  // shut so a recycled row never shows the previous climb's open panel.
  // reset() (vs close()) skips the animation — an animated slide-shut on a
  // recycle would read as a glitch. The reset lands on the next UI frame, so a
  // row recycled mid-swipe can flash its panel for ~1 frame; the opaque
  // contentRow background occludes the panel once translation returns to 0, so
  // that background must stay opaque. (useSwipeArm disarms the lazy panels on
  // the same climb.uuid change.)
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
    const press = onPressRef.current;
    if (!press) return;
    hapticLight();
    press(climbRef.current);
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
    const addToQueue = onAddToQueueRef.current;
    if (!addToQueue) return;
    hapticSuccess();
    addToQueue(climbRef.current);
  }, []);

  const handleOpenPlaylist = useCallback(() => {
    const openPlaylist = onOpenPlaylistRef.current;
    if (!openPlaylist) return;
    hapticMedium();
    openPlaylist(climbRef.current);
  }, []);

  // Snap the row shut once it has fully settled open. Runs after the action
  // already fired on willOpen, so the user sees an instant commit and the row
  // springs back.
  const handleSwipeableOpened = useCallback(() => {
    swipeableRef.current?.close();
  }, []);

  // Once the row has fully settled shut again — whether after a committed swipe
  // (handleSwipeableOpened → close()) or a sub-threshold swipe that springs back
  // — drop the lazy panels back to the cheap shell. translation is 0 by now, so
  // unmounting the heavy inner is invisible, and an idle row that's been swiped
  // once no longer keeps the animated inner mounted for the rest of its life.
  const handleSwipeableClosed = useCallback(() => {
    disarm();
  }, [disarm]);

  // Fired once when a horizontal drag begins (from a resting/closed row). This
  // is the trigger that mounts the heavy animated action panels — the direction
  // doesn't matter (we arm both sides; the non-dragged side stays occluded by
  // the opaque row), so the panel reveal is fully animated by the time any
  // meaningful translation is on screen.
  const handleSwipeStartDrag = useCallback(() => {
    arm();
  }, [arm]);

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
  // (right-to-left swipe) = Playlist. These read dragArmedRef.current rather
  // than the armed state directly so they stay dep-free: a changed render-
  // callback reference makes ReanimatedSwipeable re-create the action-panel
  // subtree, which would remount the heavy inner the instant it appears. The
  // armed state change re-renders the row (and so re-runs these callbacks),
  // while the stable identity keeps the shell→inner swap in place.
  const renderLeftActions = useCallback(
    (_progress: SharedValue<number>, translation: SharedValue<number>) => (
      <QueueSwipeAction translation={translation} active={dragArmedRef.current} />
    ),
    [dragArmedRef],
  );
  const renderRightActions = useCallback(
    (_progress: SharedValue<number>, translation: SharedValue<number>) => (
      <PlaylistSwipeAction translation={translation} active={dragArmedRef.current} />
    ),
    [dragArmedRef],
  );

  const rowContent = renderContent ? (
    renderContent({ climb, boardName, layoutId, sizeId, setIds, angle })
  ) : (
    <ClimbListItemContent
      climb={climb}
      boardName={boardName}
      layoutId={layoutId}
      sizeId={sizeId}
      setIds={setIds}
      angle={angle}
    />
  );

  const rowInner = (
    <GestureDetector gesture={tapGesture}>
      <View
        testID="climb-row"
        style={[climbListRowStyles.contentRow, { backgroundColor: systemColors.background }, contentRowStyle]}
        accessible
        accessibilityRole="button"
        accessibilityLabel={climb.name}
        accessibilityState={{ selected: !!selected }}
      >
        {/* Active-climb highlight: violet wash + left accent bar */}
        {selected ? (
          <View style={[styles.selectedFill, { backgroundColor: highlight.fill }]} pointerEvents="none" />
        ) : null}
        {selected ? (
          <View style={[styles.selectedAccent, { backgroundColor: highlight.accent }]} pointerEvents="none" />
        ) : null}

        {rowContent}
      </View>
    </GestureDetector>
  );

  return (
    <View style={[styles.outerContainer, containerStyle, unsupported && styles.unsupported]}>
      {/* Diagnostic: disableSwipe drops the ReanimatedSwipeable so a tester can check
          whether the per-row horizontal pan is stealing the list's vertical scroll. */}
      {disableSwipe ? (
        rowInner
      ) : (
        <ReanimatedSwipeable
          ref={swipeableRef}
          friction={SWIPE_FRICTION}
          leftThreshold={COMMIT_THRESHOLD}
          rightThreshold={COMMIT_THRESHOLD}
          overshootLeft={false}
          overshootRight={false}
          renderLeftActions={onAddToQueue ? renderLeftActions : undefined}
          renderRightActions={onOpenPlaylist ? renderRightActions : undefined}
          onSwipeableOpenStartDrag={handleSwipeStartDrag}
          onSwipeableWillOpen={handleSwipeWillOpen}
          onSwipeableOpen={handleSwipeableOpened}
          onSwipeableClose={handleSwipeableClosed}
        >
          {rowInner}
        </ReanimatedSwipeable>
      )}

      {/* Separator — inset to start at the text column (after the thumbnail) */}
      {showSeparator ? (
        <View style={[climbListRowStyles.separator, { backgroundColor: systemColors.separator }, separatorStyle]} />
      ) : null}
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
  // Active-climb wash + left accent bar. The COLOUR is applied inline from the
  // scheme-aware brand (see `highlight` / selectedRowColors) so dark mode uses the
  // lifted #A78BFA tint instead of the near-invisible dark fill — only layout
  // lives here. The 0.18 wash alpha reads on near-black OLED, where the accent bar
  // scrolls off during a swipe and the wash is the only state cue left.
  selectedFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  selectedAccent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 5,
  },
  swipeAction: {
    width: ACTION_REVEAL,
    justifyContent: 'center',
  },
  // Pin each icon to the OUTER edge of its panel (queue = right/screen edge,
  // playlist = left/screen edge) so it appears as soon as the panel starts
  // revealing, instead of needing half the panel out to see a centred icon.
  // These are full-bleed panels with WHITE icons, so they use the static brand
  // FILL (white-legible in both schemes); the lifted dark-mode tints would fail
  // white-on-fill contrast, so they intentionally don't vary by colour scheme.
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
