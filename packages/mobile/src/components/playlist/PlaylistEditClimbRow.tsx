import { memo, useCallback, useMemo } from 'react';
import {
  Pressable,
  View,
  StyleSheet,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, { useAnimatedStyle, withSpring } from 'react-native-reanimated';
import { GestureDetector } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';
import type { BoardName } from '@boardsesh/shared-schema';
import type { Climb } from '@boardsesh/queue';
import { Icon } from '../Icon';
import { ClimbListItemContent } from '../ClimbListItemContent';
import { THUMBNAIL_WIDTH } from '../ClimbListThumbnail';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';
import { springs } from '../../theme/animations';
import { useTheme } from '../../providers/theme-provider';
import { hapticMedium } from '../../lib/haptics';
import { rowReorderShift } from '../play-drawer/queue-drag-math';
import type { PlaylistDragControls } from './use-playlist-drag';

// Leading remove control + trailing drag handle slots. The separator starts
// under the climb name (after the remove slot + thumbnail) so it lines up with
// the name column, matching the queue row idiom.
const CONTROL_SLOT_WIDTH = 36;
const SEPARATOR_INSET = spacing[3] + CONTROL_SLOT_WIDTH + spacing[3] + THUMBNAIL_WIDTH + spacing[3];

// VoiceOver / TalkBack adjustable actions on the drag handle: swipe up/down (iOS)
// or the increment/decrement gestures (Android) move the climb one slot, so
// screen-reader users can reorder without performing the pan gesture.
const REORDER_A11Y_ACTIONS: readonly AccessibilityActionInfo[] = [{ name: 'increment' }, { name: 'decrement' }];

export type PlaylistEditRowBoard = {
  boardName: BoardName;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

type PlaylistEditClimbRowProps = {
  climb: Climb;
  board: PlaylistEditRowBoard;
  /** This row's index within the editable list (drag coordinate). */
  rowIndex: number;
  drag: PlaylistDragControls;
  onRemove: (climbUuid: string) => void;
  /** Move this climb to a new index — used by the screen-reader adjustable
   *  actions (the pan gesture commits through `drag`). */
  onReorder: (climbUuid: string, newIndex: number) => void;
};

function PlaylistEditClimbRowComponent({
  climb,
  board,
  rowIndex,
  drag,
  onRemove,
  onReorder,
}: PlaylistEditClimbRowProps) {
  const { systemColors } = useTheme();
  const { t } = useTranslation('playlists');

  const handleRemove = useCallback(() => {
    hapticMedium();
    onRemove(climb.uuid);
  }, [climb.uuid, onRemove]);

  // Screen-reader reorder: increment moves the climb one slot down the list,
  // decrement one slot up. The host clamps to the list bounds and no-ops at the
  // edges, so an out-of-range target here is harmless.
  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      const delta = event.nativeEvent.actionName === 'increment' ? 1 : -1;
      onReorder(climb.uuid, rowIndex + delta);
    },
    [onReorder, climb.uuid, rowIndex],
  );

  // Long-press drag gesture for this row's handle. Memoized on the row's
  // identity so it doesn't churn as the list re-renders.
  const dragHandleGesture = useMemo(() => drag.makeHandleGesture(rowIndex, climb.uuid), [drag, rowIndex, climb.uuid]);

  // Lift the dragged row and shift its siblings to open a gap — reads the
  // list-level drag shared values on the UI thread (outside React's render).
  const dragShared = drag.shared;
  const dragAnimatedStyle = useAnimatedStyle(() => {
    if (dragShared.activeUuid.value === null) {
      return { transform: [{ translateY: 0 }], zIndex: 0, elevation: 0 };
    }
    if (dragShared.activeUuid.value === climb.uuid) {
      return {
        transform: [{ translateY: dragShared.dragTranslateY.value }, { scale: 1.02 }],
        zIndex: 30,
        elevation: 10,
      };
    }
    const shift = rowReorderShift(
      rowIndex,
      dragShared.activeRowIndex.value,
      dragShared.targetRowIndex.value,
      dragShared.rowHeight.value,
    );
    return { transform: [{ translateY: withSpring(shift, springs.interactive) }], zIndex: 0, elevation: 0 };
  });

  const handleRowLayout = useCallback(
    (event: LayoutChangeEvent) => {
      drag.onRowHeight(event.nativeEvent.layout.height);
    },
    [drag],
  );

  return (
    <Animated.View style={dragAnimatedStyle} onLayout={handleRowLayout}>
      <View style={[styles.row, { backgroundColor: systemColors.secondaryBackground }]}>
        {/* Leading: red remove control */}
        <Pressable
          onPress={handleRemove}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('editClimbs.removeAria', { name: climb.name })}
          style={({ pressed }) => [styles.controlSlot, pressed && styles.pressed]}
        >
          <Icon name="minus.circle" size={24} color={iosSystemColors.systemRed} />
        </Pressable>

        {/* Center: shared climb visual (thumbnail + name/subtitle + grade). Ascent
            status is dropped in edit mode to keep the row focused on curation. */}
        <ClimbListItemContent
          climb={climb}
          boardName={board.boardName}
          layoutId={board.layoutId}
          sizeId={board.sizeId}
          setIds={board.setIds}
          angle={board.angle}
          showAscentStatus={false}
        />

        {/* Trailing: drag handle */}
        <GestureDetector gesture={dragHandleGesture}>
          <View
            style={styles.controlSlot}
            accessibilityRole="adjustable"
            accessibilityLabel={t('editClimbs.dragHandleAria', { name: climb.name })}
            accessibilityActions={REORDER_A11Y_ACTIONS}
            onAccessibilityAction={handleAccessibilityAction}
          >
            <Icon name="drag.handle" size={22} color={iosSystemColors.systemGray} />
          </View>
        </GestureDetector>
      </View>

      <View style={[styles.separator, { marginLeft: SEPARATOR_INSET, backgroundColor: systemColors.separator }]} />
    </Animated.View>
  );
}

/**
 * A climb row in the playlist edit list: a red remove control on the leading
 * edge and a drag handle on the trailing edge, around the shared climb visual.
 * Memoized — the actively-dragged row reacts via the drag shared values on the UI
 * thread, so a drag never re-renders the rest of the list.
 */
export const PlaylistEditClimbRow = memo(PlaylistEditClimbRowComponent);

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: spacing[3],
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[3],
  },
  controlSlot: {
    width: CONTROL_SLOT_WIDTH,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  pressed: {
    opacity: 0.6,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
  },
});
