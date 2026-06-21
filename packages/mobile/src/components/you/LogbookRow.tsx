import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
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
import type { AscentFeedItem } from '@boardsesh/graphql/operations';
import { getLayoutDisplayName, formatTickRelativeTime } from '@boardsesh/profile-stats';
import { getGradeTextColor } from '@boardsesh/play-view';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { type IconName } from '../icon-map';
import { ClimbListItemContent, type ClimbListItemClimb } from '../ClimbListItemContent';
import { useSwipeArm } from '../use-swipe-arm';
import { gradeBadgeColor } from './profile-chart-colors';
import { brandColors, withAlpha } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing, borderRadius } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { getBoardConfigForPlaylist } from '../../lib/playlists/board-details-for-playlist';
import { hapticSelection, hapticMedium, hapticLight, hapticSuccess } from '../../lib/haptics';

type LogbookRowProps = {
  ascent: AscentFeedItem;
  /** Tap → the row's primary action (logbook: activate + open play drawer;
   *  beta-share: attach the video to this climb). */
  onActivate: (ascent: AscentFeedItem) => void;
  /** Long press → open the climb actions sheet. Omit to disable long-press
   *  (e.g. the beta-share picker, where the row is a plain selector). */
  onOpenActions?: (ascent: AscentFeedItem) => void;
  /** Swipe left-to-right → edit the logbook entry. Owner-only; when omitted the
   *  left swipe action is disabled (you can't edit another climber's ticks). */
  onEdit?: (ascent: AscentFeedItem) => void;
};

// Swipe tuning mirrors ClimbListRow: drag up to ACTION_REVEAL wide; dragging
// past COMMIT_THRESHOLD and releasing commits the edit action (no resting-open
// state). friction=1 tracks the finger 1:1.
const ACTION_REVEAL = 150;
const COMMIT_THRESHOLD = 96;
const SWIPE_FRICTION = 1;

// Module-level status metadata keeps the virtualised list from allocating icon
// maps per row. The shared climb-list row uses these colours as tints; the
// fallback text row keeps the older filled badge.
const STATUS_META: Record<AscentFeedItem['status'], { icon: IconName; color: string }> = {
  flash: { icon: 'flash', color: brandColors.warning },
  send: { icon: 'tick', color: brandColors.success },
  attempt: { icon: 'circle', color: iosSystemColors.systemGray },
};

function ascentToClimb(ascent: AscentFeedItem): ClimbListItemClimb | null {
  if (!ascent.frames) return null;
  return {
    uuid: ascent.climbUuid,
    name: ascent.climbName,
    frames: ascent.frames,
    difficulty: ascent.difficultyName ?? ascent.consensusDifficultyName ?? '',
    ascensionist_count: 0,
    quality_average: ascent.qualityAverage != null ? String(ascent.qualityAverage) : '0',
    setter_username: ascent.setterUsername ?? '',
    benchmark_difficulty: ascent.isBenchmark ? (ascent.consensusDifficultyName ?? ascent.difficultyName ?? null) : null,
    mirrored: ascent.isMirror,
    is_no_match: ascent.isNoMatch,
  };
}

/**
 * Drag-driven inner of the leading "Edit" swipe action — the pencil grows in
 * with the drag plus a haptic detent at the commit threshold. Only mounted while
 * the row is being dragged; the edit itself fires from onSwipeableWillOpen.
 */
function EditSwipeActionInner({ translation }: { translation: SharedValue<number> }) {
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
      <Icon name="edit" size={24} color={iosSystemColors.white} />
    </Animated.View>
  );
}

/**
 * Leading "Edit" swipe action (left-to-right swipe) — commit-on-release opens
 * the logbook edit sheet. Cheap shell while resting; mounts the animated inner
 * once a drag starts (`active`). At translation=0 the pencil is fully
 * transparent, so the resting shell renders no icon.
 */
function EditSwipeAction({ translation, active }: { translation: SharedValue<number>; active: boolean }) {
  return <View style={styles.swipeAction}>{active ? <EditSwipeActionInner translation={translation} /> : null}</View>;
}

export const LogbookRow = memo(function LogbookRow({ ascent, onActivate, onOpenActions, onEdit }: LogbookRowProps) {
  const { t } = useTranslation('you');
  const { systemColors } = useTheme();
  const { formatGrade, formatGradeByDifficultyId } = useGradeFormat();

  const meta = STATUS_META[ascent.status];
  const rawGradeLabel = ascent.difficultyName ?? ascent.consensusDifficultyName;
  const gradeLabel =
    formatGradeByDifficultyId(ascent.difficulty ?? ascent.consensusDifficulty) ??
    formatGrade(rawGradeLabel) ??
    rawGradeLabel;
  const gradeColor = gradeLabel ? gradeBadgeColor(rawGradeLabel ?? gradeLabel) : undefined;
  const layoutName = getLayoutDisplayName(ascent.boardType, ascent.layoutId);
  const boardLabel = ascent.boardDisplayName ?? layoutName;
  const triesLabel = t('mobile.logbook.tries', { count: ascent.attemptCount });
  const subtitleParts = [boardLabel, triesLabel, `${ascent.angle}°`, formatTickRelativeTime(ascent.climbedAt)];
  const subtitle = subtitleParts.join(' · ');
  const climb = ascentToClimb(ascent);
  const boardConfig = getBoardConfigForPlaylist(ascent.boardType, ascent.layoutId);

  const swipeableRef = useRef<SwipeableMethods>(null);

  // Lazy swipe panel: the heavy animated inner only mounts once a drag actually
  // starts on this row. The hook resets the machine on recycle (ascent.uuid) and
  // exposes a ref so the render callback stays dep-free (see useSwipeArm).
  const { armedRef: dragArmedRef, arm, disarm } = useSwipeArm(ascent.uuid);

  // FlashList recycles rows (same instance, new ascent). Snap any open swipe shut
  // so a recycled row never shows the previous ascent's open panel.
  useEffect(() => {
    swipeableRef.current?.reset();
  }, [ascent.uuid]);

  // Stable refs so gesture/worklet callbacks never close over stale props.
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;
  const onOpenActionsRef = useRef(onOpenActions);
  onOpenActionsRef.current = onOpenActions;
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;
  const ascentRef = useRef(ascent);
  ascentRef.current = ascent;

  const handleRowPress = useCallback(() => {
    hapticSelection();
    onActivateRef.current(ascentRef.current);
  }, []);

  const handleLongPress = useCallback(() => {
    const openActions = onOpenActionsRef.current;
    if (!openActions) return;
    hapticMedium();
    openActions(ascentRef.current);
  }, []);

  const handleEdit = useCallback(() => {
    const edit = onEditRef.current;
    if (!edit) return;
    hapticSuccess();
    edit(ascentRef.current);
  }, []);

  // Snap shut once fully settled open (the edit already fired on willOpen).
  const handleSwipeableOpened = useCallback(() => {
    swipeableRef.current?.close();
  }, []);

  const handleSwipeableClosed = useCallback(() => {
    disarm();
  }, [disarm]);

  const handleSwipeStartDrag = useCallback(() => {
    arm();
  }, [arm]);

  const handleSwipeWillOpen = useCallback(
    (direction: 'left' | 'right') => {
      // ReanimatedSwipeable reports the SWIPE direction: 'right' fires when the
      // LEFT actions (Edit) open (left-to-right swipe). Only the left side exists.
      if (direction === 'right') handleEdit();
    },
    [handleEdit],
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

  // Long-press wins over tap; a quick tap fires once the long-press fails. With
  // no long-press handler (beta-share picker) the row is tap-only.
  const tapGesture = useMemo(
    () => (onOpenActions ? Gesture.Exclusive(longPressGesture, singleTapGesture) : singleTapGesture),
    [onOpenActions, longPressGesture, singleTapGesture],
  );

  // Reads dragArmedRef.current rather than the armed state directly so it stays
  // dep-free: a changed render-callback reference makes ReanimatedSwipeable
  // re-create the action-panel subtree (remounting the heavy inner). The armed
  // state change re-renders the row, while the stable identity keeps the
  // shell→inner swap in place.
  const renderLeftActions = useCallback(
    (_progress: SharedValue<number>, translation: SharedValue<number>) => (
      <EditSwipeAction translation={translation} active={dragArmedRef.current} />
    ),
    [dragArmedRef],
  );

  const rowContent =
    climb && boardConfig ? (
      <View style={[styles.row, { backgroundColor: systemColors.secondaryBackground }]}>
        <View style={styles.statusSlot}>
          <View style={[styles.statusIcon, { backgroundColor: withAlpha(meta.color, 0.15) }]}>
            <Icon name={meta.icon} size={14} color={meta.color} />
          </View>
        </View>
        <ClimbListItemContent
          climb={climb}
          boardName={boardConfig.boardName}
          layoutId={boardConfig.layoutId}
          sizeId={boardConfig.sizeId}
          setIds={boardConfig.setIds.join(',')}
          angle={ascent.angle}
          subtitleDetailParts={subtitleParts}
          showAscentStatus={false}
        />
      </View>
    ) : (
      <View style={[styles.fallbackRow, { backgroundColor: systemColors.background }]}>
        <View style={[styles.badge, { backgroundColor: meta.color }]}>
          <Icon name={meta.icon} size={14} color={iosSystemColors.white} />
        </View>
        <View style={styles.fallbackText}>
          <Text variant="body" numberOfLines={1}>
            {ascent.climbName}
          </Text>
          <Text variant="subheadline" style={styles.fallbackSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <View style={styles.trailing}>
          {gradeLabel && gradeColor ? (
            <View style={[styles.gradePill, { backgroundColor: gradeColor }]}>
              <Text variant="caption1" color={getGradeTextColor(gradeColor)} style={styles.gradeText}>
                {gradeLabel}
              </Text>
            </View>
          ) : null}
          <Text variant="caption2" color={systemColors.tertiaryLabel}>
            {triesLabel}
          </Text>
        </View>
      </View>
    );

  const separatorStyle = climb && boardConfig ? styles.separatorRich : styles.separatorFallback;

  return (
    <View style={styles.outerContainer}>
      <ReanimatedSwipeable
        ref={swipeableRef}
        friction={SWIPE_FRICTION}
        leftThreshold={COMMIT_THRESHOLD}
        overshootLeft={false}
        renderLeftActions={onEdit ? renderLeftActions : undefined}
        onSwipeableOpenStartDrag={handleSwipeStartDrag}
        onSwipeableWillOpen={handleSwipeWillOpen}
        onSwipeableOpen={handleSwipeableOpened}
        onSwipeableClose={handleSwipeableClosed}
      >
        <GestureDetector gesture={tapGesture}>
          <View accessible accessibilityRole="button" accessibilityLabel={ascent.climbName}>
            {rowContent}
          </View>
        </GestureDetector>
      </ReanimatedSwipeable>
      <View style={[separatorStyle, { backgroundColor: systemColors.separator }]} />
    </View>
  );
});

const styles = StyleSheet.create({
  outerContainer: {
    position: 'relative',
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: spacing[3],
    paddingVertical: spacing[2],
    paddingHorizontal: spacing[3],
  },
  statusSlot: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  separatorRich: {
    height: StyleSheet.hairlineWidth,
    marginLeft: spacing[3] + 28 + spacing[3],
  },
  separatorFallback: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 16 + 12 + 28,
  },
  fallbackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 44,
  },
  fallbackText: {
    flex: 1,
    justifyContent: 'center',
    marginLeft: 12,
  },
  fallbackSubtitle: {
    opacity: 0.6,
    marginTop: 2,
  },
  badge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trailing: {
    alignItems: 'flex-end',
    gap: 2,
    marginLeft: 8,
  },
  gradePill: {
    paddingHorizontal: spacing[2],
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
  },
  gradeText: { fontWeight: '700' },
  swipeAction: {
    width: ACTION_REVEAL,
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingLeft: 22,
    backgroundColor: brandColors.primary,
  },
});
