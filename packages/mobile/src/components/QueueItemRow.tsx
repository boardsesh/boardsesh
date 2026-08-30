import { memo, useMemo, useCallback, useEffect, useRef } from 'react';
import { Pressable, View, StyleSheet, type AccessibilityActionEvent, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming, runOnJS } from 'react-native-reanimated';
import {
  Gesture,
  GestureDetector,
  type GestureType,
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
import { BoardDriverAvatar } from './board-presence/BoardDriverAvatar';
import { resolveQueueRowAttribution } from '../lib/queue-attribution';
import { iosSystemColors } from '../theme/ios-colors';
import { spacing } from '../theme/tokens';
import { springs } from '../theme/animations';
import { useTheme } from '../providers/theme-provider';
import { hapticSelection, hapticMedium } from '../lib/haptics';
import type { QueueDragControls } from './play-drawer/use-queue-drag';
import { rowReorderShift } from './play-drawer/queue-drag-math';
import { ACTIVATE_ACCESSIBILITY_ACTIONS, rowAccessibilityActionsWith } from '../lib/row-accessibility-actions';

// The tick button is nested inside the row's `accessible` container, so it needs
// both its own props (TalkBack focuses it) and a labelled custom action published
// on the row (VoiceOver does not) — see lib/row-accessibility-actions.
const LOG_ASCENT_ACTION_NAME = 'logAscent';

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
  /** Long press → open the climb reaction menu (omit to disable long-press). */
  onOpenActions?: (item: ClimbQueueItem) => void;
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
  /** Show who queued this climb. True only while a party session is active. */
  showAddedBy?: boolean;
  /** The viewer's own party-profile id; their own adds render no avatar. */
  viewerUserId?: string | null;
};

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
  onOpenActions,
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
  showAddedBy = false,
  viewerUserId = null,
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
  // stable `item.uuid` — otherwise every queue update hands the row's gestures a
  // new `onPress`/`onTickHistory` and forces a re-render despite the memo.
  const itemRef = useRef(item);
  itemRef.current = item;

  // Refs so the drag handle's Pan gesture can `blocksExternalGesture` the row's own
  // tap/long-press (see dragHandleGesture below) — a touch that starts on the handle
  // is claimed exclusively by the drag and never also opens the reaction menu. Mirrors
  // the identical ⋯-button-vs-row relationship in ClimbListRow.
  const singleTapRef = useRef<GestureType | undefined>(undefined);
  const longPressRef = useRef<GestureType | undefined>(undefined);

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
        // Activate only on a leftward drag past 10px — the swipe is left-only (a
        // rightward drag is discarded in onUpdate below), so it must never claim a
        // rightward or right-diagonal gesture. A symmetric [-10, 10] activated on
        // right-and-down drags too, and once the Y bail widened to 14px (#3295) a
        // +11px-X/+13px-Y drag would cross +10px X before 14px Y and capture the Pan
        // as a no-op, blocking the list from scrolling. Single-negative activeOffsetX
        // sets only the leftward threshold, so rightward motion yields to the scroll.
        // Bail once the drag is clearly vertical (14px). A tighter [-5, 5] Y bail was
        // so narrow that the normal vertical wobble of a horizontal swipe tripped it
        // before the 10px X activation — the Pan failed, never engaged, and the row's
        // tap fell through and just selected the climb instead of revealing Delete
        // (#3295). 14px tolerates that wobble while still ceding to a real vertical
        // scroll (which crosses 14px in Y well before 10px in X). These are the
        // thresholds the board manager's swipe-to-delete row also used before it
        // was retired.
        .activeOffsetX(-10)
        .failOffsetY([-14, 14])
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

  // Screen-reader activate → the same handlers the RNGH taps call. Branch on the
  // action name so adding a second custom action to these rows later can't turn
  // every action into a row press.
  const handleRowAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'activate') handlePress();
      if (event.nativeEvent.actionName === LOG_ASCENT_ACTION_NAME) handleTickPress();
    },
    [handlePress, handleTickPress],
  );

  const handleTickAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'activate') handleTickPress();
    },
    [handleTickPress],
  );

  const handleLongPress = useCallback(() => {
    if (isEditMode || !onOpenActions) return;
    hapticMedium();
    onOpenActions(itemRef.current);
  }, [isEditMode, onOpenActions]);

  // Row press/long-press run as RNGH gestures — not RN core Pressable's onPress/
  // onLongPress — so they can be arbitrated against the nested drag-handle's Pan
  // gesture in the same gesture arena (see dragHandleGesture below). Before this,
  // onLongPress lived on a plain Pressable wrapping the handle's GestureDetector:
  // two independent touch systems (RN's legacy responder + RNGH's native arena)
  // raced for the same hold, and on iOS the row's long-press could win, opening the
  // reaction menu instead of letting the handle's Pan activate. Mirrors ClimbListRow's
  // singleTapGesture/longPressGesture/tapGesture composition.
  const singleTapGesture = useMemo(
    () =>
      Gesture.Tap()
        .withRef(singleTapRef)
        .maxDuration(300)
        .maxDistance(15)
        .onStart(() => {
          'worklet';
          runOnJS(handlePress)();
        }),
    [handlePress],
  );

  const longPressGesture = useMemo(
    () =>
      Gesture.LongPress()
        .withRef(longPressRef)
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

  // Long-press drag handle gesture (future rows only). Memoized on the row's
  // identity so it doesn't churn while the list re-renders. `blocksExternalGesture`
  // makes the row's own tap/long-press wait for this gesture to fail before they can
  // activate — a touch that starts on the handle is claimed by the drag (or falls
  // through to a plain row tap if released before the long-press-to-arm threshold),
  // and never also opens the reaction menu.
  const dragHandleGesture = useMemo(() => {
    if (!isDraggable || !drag || rowIndex == null || queueIndex == null) return null;
    return drag.makeHandleGesture(rowIndex, item.uuid, queueIndex).blocksExternalGesture(singleTapRef, longPressRef);
  }, [isDraggable, drag, rowIndex, queueIndex, item.uuid]);

  // The history-row tick button's own tap. Like the drag handle, it
  // `blocksExternalGesture`s the row's tap/long-press so a touch that starts on the
  // tick opens Log Ascent without also firing the row press — which would make the
  // history climb current, open the Play Drawer, and dismiss the Queue Sheet. Only
  // built for history rows (see showTick). Mirrors ClimbListRow's moreButtonGesture.
  const tickGesture = useMemo(() => {
    if (!isHistoryItem || isEditMode || !onTickHistory) return null;
    return Gesture.Tap()
      .maxDuration(300)
      .maxDistance(15)
      .blocksExternalGesture(singleTapRef, longPressRef)
      .onStart(() => {
        'worklet';
        runOnJS(handleTickPress)();
      });
  }, [isHistoryItem, isEditMode, onTickHistory, handleTickPress]);

  // Take the layout event directly so the same stable function can be passed to
  // `onLayout` — an inline `(event) => ...` wrapper would be a fresh arrow each
  // render, defeating the row's memoization on the wrapping `Animated.View`.
  const handleRowLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (isDraggable) drag?.onRowHeight(event.nativeEvent.layout.height);
    },
    [isDraggable, drag],
  );

  // `||` (not `??`) so a partially-synced item with an empty-string name also
  // falls back to the placeholder label instead of an empty accessibility string.
  const climbName = item.climb?.name || t('mobile.queue.unknownClimb');

  const showTick = !!tickGesture;
  const showDragHandle = !!dragHandleGesture && !isEditMode;

  // Keyed on the resolved label string, not on `t` — react-i18next hands back a new
  // `t` identity on plenty of renders, which would rebuild this array every time
  // and churn the row element's props.
  const logAscentLabel = t('mobile.queue.logAscent');
  const rowAccessibilityActions = useMemo(
    () =>
      showTick
        ? rowAccessibilityActionsWith({ name: LOG_ASCENT_ACTION_NAME, label: logAscentLabel })
        : ACTIVATE_ACCESSIBILITY_ACTIONS,
    [showTick, logAscentLabel],
  );

  // History rows pin the grade for the angle the climb was CLIMBED at, which can
  // differ from the live board angle (e.g. the session moved on after the send).
  // Surface the climbed-at angle only when it differs — no chip on the common
  // case where history and the wall share an angle.
  const climbedAtAngle = item.climb?.angle;
  const showSentAtAngle =
    isHistoryItem && !isEditMode && typeof climbedAtAngle === 'number' && climbedAtAngle !== board.angle;

  const addedBy = resolveQueueRowAttribution(item.addedByUser, {
    showAddedBy,
    viewerUserId,
  });
  // Edit mode strips secondary chrome (same rule as the sent-at-angle chip) and
  // is the row's widest state — the checkbox slot plus the delete affordance.
  // Only the glyph goes: the accessibility label has no width budget, and a
  // VoiceOver user needs to know whose climb they are about to bulk-delete.
  const showAddedByAvatar = addedBy != null && !isEditMode;

  // A plain const, deliberately NOT a useMemo: `rowAccessibilityActions` above is
  // memoized because a test asserts its identity across re-renders, but a string
  // has no such contract and memoizing it would only add a deps array to keep true.
  const positionLabel = t('mobile.queue.positionLabel', { position });
  const rowAccessibilityLabel = addedBy
    ? `${climbName}, ${positionLabel}, ${t('mobile.queue.addedByAria', { name: addedBy.name })}`
    : `${climbName}, ${positionLabel}`;

  const rowContent = (
    // touchAction="pan-y" (web only): RNGH otherwise defaults the row's DOM node
    // to `touch-action: none`, which blocks native touch-scrolling for any drag
    // starting on the row. pan-y lets a vertical drag fall through to the list's
    // own scroll natively; only a horizontal drag is intercepted here or by the
    // swipe Pan below.
    <GestureDetector gesture={tapGesture} touchAction="pan-y">
      <Animated.View
        accessible
        accessibilityRole="button"
        accessibilityLabel={rowAccessibilityLabel}
        accessibilityState={{ selected: isEditMode ? isSelected : isCurrentClimb }}
        onAccessibilityTap={handlePress}
        accessibilityActions={rowAccessibilityActions}
        onAccessibilityAction={handleRowAccessibilityAction}
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

        {/* Sent-at-angle chip: history climbed at an angle other than the wall's */}
        {showSentAtAngle && (
          <Text
            variant="caption1"
            color={iosSystemColors.systemGray}
            style={styles.sentAtAngle}
            accessibilityLabel={t('mobile.queue.sentAtAngle', { angle: climbedAtAngle })}
          >
            {t('mobile.queue.sentAtAngle', { angle: climbedAtAngle })}
          </Text>
        )}

        {/* Who queued it — decorative; the row's own label carries the name. */}
        {showAddedByAvatar && addedBy && (
          <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.addedByAvatar}
          >
            <BoardDriverAvatar uri={addedBy.avatarUrl} name={addedBy.name} size={20} status="none" />
          </View>
        )}

        {/* Trailing action: tick (history) or drag handle (upcoming) */}
        {showTick && tickGesture ? (
          <GestureDetector gesture={tickGesture} touchAction="pan-y">
            <View
              testID="tick-button"
              accessible
              accessibilityRole="button"
              accessibilityLabel={t('mobile.queue.logAscent')}
              onAccessibilityTap={handleTickPress}
              accessibilityActions={ACTIVATE_ACCESSIBILITY_ACTIONS}
              onAccessibilityAction={handleTickAccessibilityAction}
              style={styles.trailingButton}
            >
              <Icon name="tick" size={26} color={brandColors.success} />
            </View>
          </GestureDetector>
        ) : showDragHandle && dragHandleGesture ? (
          // Deliberately NOT given an `activate` action: reordering with a screen
          // reader needs worded move-up/move-down custom actions, not a plain
          // activate (an activate here has nothing meaningful to do). That's a UX
          // decision, tracked as a follow-up rather than guessed at here.
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
      </Animated.View>
    </GestureDetector>
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

        {swipeEnabled ? (
          // touchAction="pan-y": same web-only reasoning as the tap GestureDetector
          // above — without it this Pan's DOM node defaults to `touch-action: none`
          // and swallows vertical touch-scrolls before activeOffsetX/failOffsetY
          // ever get evaluated (those only gate the JS recognizer, which the browser
          // doesn't consult once it's decided not to hand a touch to it).
          <GestureDetector gesture={panGesture} touchAction="pan-y">
            {rowContent}
          </GestureDetector>
        ) : (
          rowContent
        )}
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
  sentAtAngle: {
    flexShrink: 0,
    fontVariant: ['tabular-nums'],
  },
  addedByAvatar: {
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
