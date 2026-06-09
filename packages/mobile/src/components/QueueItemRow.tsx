import { memo, useMemo, useCallback, useEffect, useRef } from 'react';
import { Pressable, View, StyleSheet, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming, runOnJS } from 'react-native-reanimated';
import {
  Gesture,
  GestureDetector,
  type GestureUpdateEvent,
  type PanGestureHandlerEventPayload,
} from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { BoardName } from '@boardsesh/shared-schema';
import { Text } from './Text';
import { Icon } from './Icon';
import { ClimbListItemContent } from './ClimbListItemContent';
import { THUMBNAIL_WIDTH } from './ClimbListThumbnail';
import { iosSystemColors } from '../theme/ios-colors';
import { spacing } from '../theme/tokens';
import { springs } from '../theme/animations';
import { useTheme } from '../providers/theme-provider';
import { hapticSelection, hapticMedium } from '../lib/haptics';
import type { QueueDragControls } from './play-drawer/use-queue-drag';
import { rowReorderShift } from './play-drawer/queue-drag-math';

const SWIPE_DELETE_THRESHOLD = -80;
const DELETE_BUTTON_WIDTH = 80;
// Width of the leading position/play/checkbox slot. Exported so the queue list's
// suggestion rows reserve the same gutter and align their thumbnails + separator
// with the queue rows from a single source of truth.
export const POSITION_SLOT_WIDTH = 28;
// Inset the separator to start under the climb name (after position + thumbnail).
export const SEPARATOR_INSET = spacing[3] + POSITION_SLOT_WIDTH + spacing[3] + THUMBNAIL_WIDTH + spacing[3];

export type QueueItemRowBoard = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

type QueueItemRowProps = {
  item: ClimbQueueItem;
  position: number;
  board: QueueItemRowBoard;
  isCurrentClimb: boolean;
  onPress: (item: ClimbQueueItem) => void;
  onRemove: (uuid: string) => void;
  isEditMode?: boolean;
  isSelected?: boolean;
  isHistoryItem?: boolean;
  onToggleSelect?: (uuid: string) => void;
  /** Open the log-ascent sheet for an already-climbed (history) row. */
  onTickHistory?: (item: ClimbQueueItem) => void;
  /** Drag-to-reorder wiring (only passed for upcoming/future rows). */
  drag?: QueueDragControls;
  /** This row's index within the flat list (drag coordinate). */
  rowIndex?: number;
  /** This row's index within the queue array (drag commit). */
  queueIndex?: number;
  /** Whether this row may be dragged (future rows, not in edit mode). */
  isDraggable?: boolean;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function PositionIndicator({
  isEditMode,
  isSelected,
  isCurrentClimb,
  position,
}: {
  isEditMode: boolean;
  isSelected: boolean;
  isCurrentClimb: boolean;
  position: number;
}) {
  const { brandColors } = useTheme();
  if (isEditMode) {
    return (
      <Icon
        name={isSelected ? 'checkmark.circle.fill' : 'circle'}
        size={22}
        color={isSelected ? brandColors.primary : iosSystemColors.systemGray4}
      />
    );
  }

  if (isCurrentClimb) {
    return <Icon name="play.fill" size={14} color={brandColors.primary} />;
  }

  return (
    <Text variant="subheadline" color={iosSystemColors.systemGray} style={styles.positionText}>
      {String(position)}
    </Text>
  );
}

function QueueItemRowComponent({
  item,
  position,
  board,
  isCurrentClimb,
  onPress,
  onRemove,
  isEditMode = false,
  isSelected = false,
  isHistoryItem = false,
  onToggleSelect,
  onTickHistory,
  drag,
  rowIndex,
  queueIndex,
  isDraggable = false,
}: QueueItemRowProps) {
  const { systemColors, brandColors } = useTheme();
  const { t } = useTranslation('session');
  const translateX = useSharedValue(0);
  const rowOpacity = useSharedValue(1);
  const rowHeight = useSharedValue<number | undefined>(undefined);
  const isSwipeOpen = useSharedValue(false);

  // The queue reducer rebuilds the array (and each item object) on every update,
  // so `item` arrives with a fresh reference even when this row's data hasn't
  // changed. Read the live item through a ref and key the press callbacks on the
  // stable `item.uuid` — otherwise every queue update hands `AnimatedPressable` a
  // new `onPress`/`onTickHistory` and forces a re-render despite the memo.
  const itemRef = useRef(item);
  itemRef.current = item;

  // Disable swipe-to-delete for edit mode and history items.
  const swipeEnabled = !isEditMode && !isHistoryItem;

  // Reset swipe position when swipe gets disabled (e.g. entering edit mode)
  useEffect(() => {
    if (!swipeEnabled) {
      translateX.value = withSpring(0, { damping: 20, stiffness: 200 });
      isSwipeOpen.value = false;
    }
  }, [swipeEnabled, translateX, isSwipeOpen]);

  const handleRemove = useCallback(() => {
    hapticMedium();
    onRemove(item.uuid);
  }, [item.uuid, onRemove]);

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(swipeEnabled)
        .activeOffsetX([-10, 10])
        .failOffsetY([-5, 5])
        .onUpdate((event: GestureUpdateEvent<PanGestureHandlerEventPayload>) => {
          // Only allow swiping left
          if (event.translationX > 0) {
            translateX.value = 0;
            return;
          }
          translateX.value = Math.max(event.translationX, -DELETE_BUTTON_WIDTH - 20);
        })
        .onEnd(() => {
          if (translateX.value < SWIPE_DELETE_THRESHOLD) {
            translateX.value = withSpring(-DELETE_BUTTON_WIDTH, {
              damping: 20,
              stiffness: 200,
            });
            isSwipeOpen.value = true;
          } else {
            translateX.value = withSpring(0, { damping: 20, stiffness: 200 });
            isSwipeOpen.value = false;
          }
        }),
    [swipeEnabled, translateX, isSwipeOpen],
  );

  // Long-press drag handle gesture (future rows only). Memoized on the row's
  // identity so it doesn't churn while the list re-renders.
  const dragHandleGesture = useMemo(() => {
    if (!isDraggable || !drag || rowIndex == null || queueIndex == null) return null;
    return drag.makeHandleGesture(rowIndex, item.uuid, queueIndex);
  }, [isDraggable, drag, rowIndex, queueIndex, item.uuid]);

  const rowAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  // Lift the dragged row and shift its siblings to open a gap. Reads the
  // list-level drag shared values; for non-future rows (no `drag`) it stays at
  // rest. `active`/`target` always fall inside the future window, so history /
  // current rows never shift even though they share this style.
  // Capture only the shared-values bag (not the whole `drag` object, which holds
  // JS functions that can't cross to the UI thread).
  const dragShared = drag?.shared;
  const dragAnimatedStyle = useAnimatedStyle(() => {
    if (!dragShared || dragShared.activeUuid.value === null) {
      return { transform: [{ translateY: 0 }], zIndex: 0, elevation: 0 };
    }
    if (dragShared.activeUuid.value === item.uuid) {
      return {
        transform: [{ translateY: dragShared.dragTranslateY.value }, { scale: 1.02 }],
        zIndex: 30,
        elevation: 10,
      };
    }
    const shift =
      rowIndex == null
        ? 0
        : rowReorderShift(
            rowIndex,
            dragShared.activeRowIndex.value,
            dragShared.targetRowIndex.value,
            dragShared.rowHeight.value,
          );
    return { transform: [{ translateY: withSpring(shift, springs.interactive) }], zIndex: 0, elevation: 0 };
  });

  const deleteButtonStyle = useAnimatedStyle(() => {
    const width = Math.min(Math.abs(translateX.value), DELETE_BUTTON_WIDTH);
    return {
      width,
      opacity: width / DELETE_BUTTON_WIDTH,
    };
  });

  const containerAnimatedStyle = useAnimatedStyle(() => ({
    opacity: rowOpacity.value,
    height: rowHeight.value,
    overflow: 'hidden' as const,
  }));

  const handlePress = useCallback(() => {
    if (isEditMode) {
      hapticSelection();
      onToggleSelect?.(itemRef.current.uuid);
      return;
    }
    if (isSwipeOpen.value) {
      // Close the swipe first; read the shared value so this callback's
      // identity doesn't churn on every swipe open/close.
      translateX.value = withSpring(0, { damping: 20, stiffness: 200 });
      isSwipeOpen.value = false;
      return;
    }
    hapticSelection();
    onPress(itemRef.current);
  }, [isEditMode, onToggleSelect, onPress, translateX, isSwipeOpen]);

  const handleDeletePress = useCallback(() => {
    // Animate the row out
    translateX.value = withTiming(-400, { duration: 200 });
    rowOpacity.value = withTiming(0, { duration: 200 });
    rowHeight.value = withTiming(0, { duration: 200 }, () => {
      runOnJS(handleRemove)();
    });
  }, [translateX, rowOpacity, rowHeight, handleRemove]);

  const handleTickPress = useCallback(() => {
    hapticSelection();
    onTickHistory?.(itemRef.current);
  }, [onTickHistory]);

  // Take the layout event directly so the same stable function can be passed to
  // `onLayout` — an inline `(event) => ...` wrapper would be a fresh arrow each
  // render, defeating the row's memoization on the wrapping `Animated.View`.
  const handleRowLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (isDraggable) drag?.onRowHeight(event.nativeEvent.layout.height);
    },
    [isDraggable, drag],
  );

  const climbName = item.climb?.name ?? t('mobile.queue.unknownClimb');

  const showTick = isHistoryItem && !isEditMode && !!onTickHistory;
  const showDragHandle = !!dragHandleGesture && !isEditMode;

  const rowContent = (
    <AnimatedPressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`${climbName}, ${t('mobile.queue.positionLabel', { position })}`}
      accessibilityState={{ selected: isEditMode ? isSelected : isCurrentClimb }}
      style={[
        styles.row,
        { backgroundColor: systemColors.secondaryBackground },
        isCurrentClimb && !isHistoryItem && { backgroundColor: `${brandColors.primary}14` },
        isHistoryItem && styles.historyRow,
        rowAnimatedStyle,
      ]}
    >
      {/* Position number / play indicator / edit checkbox */}
      <View style={styles.positionContainer}>
        <PositionIndicator
          isEditMode={isEditMode}
          isSelected={isSelected}
          isCurrentClimb={isCurrentClimb}
          position={position}
        />
      </View>

      {/* Shared climb visual: thumbnail + name/subtitle + grade */}
      <ClimbListItemContent
        climb={item.climb}
        boardName={board.boardName}
        layoutId={board.layoutId}
        sizeId={board.sizeId}
        setIds={board.setIds}
        angle={board.angle}
      />

      {/* Trailing action: tick (history) or drag handle (upcoming) */}
      {showTick ? (
        <Pressable
          testID="tick-button"
          onPress={handleTickPress}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('mobile.queue.logAscent')}
          style={styles.trailingButton}
        >
          <Icon name="tick" size={26} color={brandColors.success} />
        </Pressable>
      ) : showDragHandle && dragHandleGesture ? (
        <GestureDetector gesture={dragHandleGesture}>
          <View
            style={styles.trailingButton}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.queue.dragHandleAria', { name: climbName })}
          >
            <Icon name="drag.handle" size={22} color={iosSystemColors.systemGray} />
          </View>
        </GestureDetector>
      ) : null}
    </AnimatedPressable>
  );

  return (
    <Animated.View style={[containerAnimatedStyle, dragAnimatedStyle]} onLayout={handleRowLayout}>
      <View style={styles.swipeContainer}>
        {/* Delete action behind the row */}
        {swipeEnabled && (
          <Animated.View style={[styles.deleteAction, deleteButtonStyle]}>
            <Pressable
              testID="delete-button"
              onPress={handleDeletePress}
              accessibilityRole="button"
              accessibilityLabel={t('mobile.queue.removeClimb')}
              style={styles.deleteButton}
            >
              <Icon name="delete" size={22} color={iosSystemColors.white} />
            </Pressable>
          </Animated.View>
        )}

        {swipeEnabled ? <GestureDetector gesture={panGesture}>{rowContent}</GestureDetector> : rowContent}
      </View>

      {/* Separator */}
      <View style={[styles.separator, { marginLeft: SEPARATOR_INSET, backgroundColor: systemColors.separator }]} />
    </Animated.View>
  );
}

// Memoized: the queue list re-renders on every drag start/end, every selection
// toggle, and unrelated parent updates. Every prop is referentially stable —
// `board`, the `on*` callbacks, and `drag` (the stable row-facing controls from
// `useQueueDrag`) — so a shallow compare lets each row skip re-rendering unless
// its own data changes. The actively-dragged row still reacts via the drag
// shared values on the UI thread, which sit outside React's render cycle.
export const QueueItemRow = memo(QueueItemRowComponent);

const styles = StyleSheet.create({
  swipeContainer: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  row: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: spacing[3],
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[3],
  },
  historyRow: {
    opacity: 0.5,
  },
  positionContainer: {
    width: POSITION_SLOT_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  positionText: {
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  trailingButton: {
    width: 36,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  deleteAction: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: iosSystemColors.systemRed,
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteButton: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
  },
});
