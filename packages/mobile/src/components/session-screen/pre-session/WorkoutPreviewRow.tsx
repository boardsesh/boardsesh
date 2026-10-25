import { memo, useCallback, useRef } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { ClimbListItemContent } from '../../ClimbListItemContent';
import { climbRowSeparatorInset } from '../../climb-row-layout';
import { Icon } from '../../Icon';
import { PressableSurface } from '../../PressableSurface';
import { Text } from '../../Text';
import type { QueueItemRowBoard } from '../../QueueItemRow';
import { useTheme } from '../../../providers/theme-provider';
import { spacing } from '../../../theme/tokens';
import { hapticSelection } from '../../../lib/haptics';
import { isMultiFrameClimb } from '../../../lib/is-multi-frame-climb';
import { formatQuality, formatSends } from '../../../lib/format-climb-stats';
import { useClimbRowDisplay } from '../../../lib/climb-row-display-preference';
import { useGradeFormat } from '../../../hooks/use-grade-format';
import type { TierAscentStatus } from './workout-search-tiers';
import { borrowedGradeLabels } from './borrowed-grade-labels';

type WorkoutPreviewRowProps = {
  item: ClimbQueueItem;
  board: QueueItemRowBoard;
  /** Highlight the row tapped to open in the play drawer. */
  isActive: boolean;
  /** Show a spinner + disable the refresh button while this row regenerates. */
  isRefreshing: boolean;
  /**
   * Dim + disable this row's refresh button while a *different* row is
   * regenerating. Refreshes run one at a time (the hook serializes them to avoid
   * clobbering each other's state), so this makes that constraint visible
   * instead of silently swallowing the tap.
   */
  refreshDisabled: boolean;
  /**
   * The mark the search that found this climb proves (`PreviewItem.knownStatus`),
   * drawn until the climb's logbook loads. Absent or null when it proves nothing.
   */
  knownStatus?: TierAscentStatus | null;
  /**
   * For a row whose climb came from a nearby grade (`PreviewItem.borrowedFrom`):
   * the difficulty id it came from and the one the plan asked for. The row then
   * says "V4 for V5" under the climb (`borrowedGradeLabels`). Absent or null on
   * every other row.
   */
  borrowedGrade?: number | null;
  plannedGrade?: number | null;
  /**
   * Opens the climb in the play drawer. Left out where the drawer would open
   * under a modal sheet (the add-block sheet): the climb area is then plain
   * content, not a button, and only the refresh button responds.
   */
  onPress?: (item: ClimbQueueItem) => void;
  onRefresh: (uuid: string) => void;
};

/**
 * A workout-preview row: the shared climb visual (`ClimbListItemContent`) plus a
 * refresh button that regenerates just this climb. Deliberately lightweight — no
 * swipe/drag/edit baggage from `QueueItemRow`, since the preview is a read-and-
 * tweak surface, not the live queue.
 */
function WorkoutPreviewRowComponent({
  item,
  board,
  isActive,
  isRefreshing,
  refreshDisabled,
  knownStatus = null,
  borrowedGrade = null,
  plannedGrade = null,
  onPress,
  onRefresh,
}: WorkoutPreviewRowProps) {
  const { systemColors, brandColors, opacity } = useTheme();
  const { t: sessionT } = useTranslation('session');
  const { t: climbsT } = useTranslation('climbs');
  const { gradeFormat, formatGrade } = useGradeFormat();
  // What the climber has switched on for climb rows. The row visual reads it for
  // itself; this row needs it for the two things it adds around that visual:
  // the label it speaks, and where its separator starts.
  const rowDisplay = useClimbRowDisplay();
  // Blocked while this row spins, or while another row holds the single refresh
  // slot. Only this row shows a spinner; the rest dim to read as "busy, wait".
  const refreshBlocked = isRefreshing || refreshDisabled;
  const itemRef = useRef(item);
  itemRef.current = item;

  const handlePress = useCallback(() => {
    if (!onPress) return;
    hapticSelection();
    onPress(itemRef.current);
  }, [onPress]);

  const handleRefresh = useCallback(() => {
    hapticSelection();
    onRefresh(item.uuid);
  }, [item.uuid, onRefresh]);

  const climb: ClimbQueueItem['climb'] | null | undefined = item.climb;
  const climbName = climb?.name ?? sessionT('mobile.queue.unknownClimb');
  const formattedGrade = climb ? (formatGrade(climb.difficulty, board.boardName) ?? climb.difficulty) : null;
  // "V4 for V5": the grade the climb came from, then the one it fills in for.
  // "V0 / 4B for V0 / 4A" when both read V0 in the climber's format.
  const borrowedLabels = borrowedGradeLabels(borrowedGrade, plannedGrade, gradeFormat, board.boardName);
  const borrowedCaption = borrowedLabels
    ? sessionT('mobile.session.preWorkoutPreviewBorrowedGrade', {
        grade: borrowedLabels.grade,
        plannedGrade: borrowedLabels.plannedGrade,
      })
    : null;
  const quality = climb ? Number(formatQuality(climb.quality_average)) : 0;
  const qualityStarCount = Math.round(quality);
  // The label replaces what a screen reader would compose from the row, so it
  // follows the same switches: a token the row does not draw is not spoken.
  const rowAccessibilityLabel = climb
    ? [
        climbName,
        formattedGrade,
        borrowedCaption,
        isMultiFrameClimb(climb.framesCount)
          ? climbsT('mobile.climbRow.frameCount', { count: climb.framesCount })
          : null,
        rowDisplay.sends && climb.ascensionist_count > 0 ? formatSends(climb.ascensionist_count, climbsT) : null,
        rowDisplay.rating && qualityStarCount > 0
          ? sessionT('playView.tickBar.starRating', { count: qualityStarCount })
          : null,
        rowDisplay.setter ? climb.setter_username : null,
      ]
        .filter(Boolean)
        .join(', ')
    : climbName;
  const climbVisual = climb ? (
    <ClimbListItemContent
      climb={climb}
      boardName={board.boardName}
      layoutId={board.layoutId}
      sizeId={board.sizeId}
      setIds={board.setIds}
      angle={board.angle}
      knownAscentStatus={knownStatus}
    />
  ) : null;
  // A borrowed row stacks the caption under the climb, starting under its name.
  const climbContent = climbVisual ? (
    borrowedCaption ? (
      <View style={styles.borrowedStack}>
        <View style={styles.climbLine}>{climbVisual}</View>
        <Text
          variant="caption1"
          color={systemColors.secondaryLabel}
          numberOfLines={1}
          style={rowDisplay.thumbnail ? captionStyles.pastThumbnail : null}
        >
          {borrowedCaption}
        </Text>
      </View>
    ) : (
      climbVisual
    )
  ) : (
    <Text variant="body" color={systemColors.secondaryLabel} numberOfLines={1} style={styles.missingClimbText}>
      {climbName}
    </Text>
  );

  return (
    <View>
      <View
        style={[
          styles.row,
          { backgroundColor: systemColors.secondaryBackground },
          isActive && { backgroundColor: `${brandColors.primary}14` },
        ]}
      >
        {onPress ? (
          <PressableSurface
            onPress={handlePress}
            feedback="opacity"
            accessibilityRole="button"
            accessibilityLabel={rowAccessibilityLabel}
            accessibilityState={{ selected: isActive }}
            style={styles.rowButton}
          >
            {climbContent}
          </PressableSurface>
        ) : (
          // One stop for a screen reader, with the same label, but no button role.
          <View accessible accessibilityLabel={rowAccessibilityLabel} style={styles.rowButton}>
            {climbContent}
          </View>
        )}

        <PressableSurface
          onPress={handleRefresh}
          disabled={refreshBlocked}
          feedback="scale"
          hitSlop={2}
          rippleBorderless
          accessibilityRole="button"
          accessibilityLabel={sessionT('mobile.session.preRegenerateClimbForClimb', { name: climbName })}
          accessibilityState={{ disabled: refreshBlocked, busy: isRefreshing }}
          style={[styles.refreshButton, refreshDisabled && !isRefreshing ? { opacity: opacity.disabled } : null]}
        >
          {isRefreshing ? (
            <ActivityIndicator size="small" color={systemColors.secondaryLabel} />
          ) : (
            <Icon name="refresh" size={22} color={systemColors.secondaryLabel} />
          )}
        </PressableSurface>
      </View>

      {/* Inset to start under the climb name (after the thumbnail, when there is
          one), matching the queue list's row separators. The row pads 12pt, not
          the 16pt gutter. */}
      <View
        style={[
          styles.separator,
          {
            marginStart: climbRowSeparatorInset(rowDisplay.thumbnail, ROW_LEADING_INSET),
            backgroundColor: systemColors.separator,
          },
        ]}
      />
    </View>
  );
}

// Memoized: the preview lists (pre-session and the add-block sheet) re-render on
// every preview rebuild and refresh-state change. Each prop is referentially
// stable except `item` (a fresh reference only for the row that actually
// changed), so a shallow compare lets untouched rows skip re-rendering. An
// absent `onPress` compares equal to itself, so a sheet row stays memoized too.
export const WorkoutPreviewRow = memo(WorkoutPreviewRowComponent, (prev, next) => {
  return (
    prev.item.uuid === next.item.uuid &&
    prev.item.climb?.uuid === next.item.climb?.uuid &&
    prev.item.climb?.framesCount === next.item.climb?.framesCount &&
    prev.isActive === next.isActive &&
    prev.isRefreshing === next.isRefreshing &&
    prev.refreshDisabled === next.refreshDisabled &&
    prev.knownStatus === next.knownStatus &&
    prev.borrowedGrade === next.borrowedGrade &&
    prev.plannedGrade === next.plannedGrade &&
    prev.onPress === next.onPress &&
    prev.onRefresh === next.onRefresh &&
    prev.board.boardName === next.board.boardName &&
    prev.board.layoutId === next.board.layoutId &&
    prev.board.sizeId === next.board.sizeId &&
    prev.board.setIds === next.board.setIds &&
    prev.board.angle === next.board.angle
  );
});

// Where the row's first column starts: the row button's own leading padding.
const ROW_LEADING_INSET = spacing[3];

// A borrowed row's caption starts under the climb name: past the thumbnail
// when the row shows one, at the row's first column when it does not.
const captionStyles = StyleSheet.create({
  pastThumbnail: { marginStart: climbRowSeparatorInset(true, 0) },
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: spacing[3],
    paddingVertical: spacing[2],
    paddingStart: ROW_LEADING_INSET,
    paddingEnd: spacing[2],
  },
  // Takes the row button's width, so the caption lines up under the climb.
  borrowedStack: {
    flex: 1,
    rowGap: spacing[1],
  },
  // The row button's own line, for the climb visual's columns inside the stack.
  climbLine: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: spacing[3],
  },
  missingClimbText: {
    flex: 1,
    fontWeight: '600',
  },
  refreshButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    flexShrink: 0,
    marginEnd: spacing[3],
  },
  separator: {
    height: StyleSheet.hairlineWidth,
  },
});
