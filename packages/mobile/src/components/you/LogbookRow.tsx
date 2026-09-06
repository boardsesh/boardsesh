import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet, type AccessibilityActionEvent } from 'react-native';
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
import { getLayoutDisplayName, parseTickTime } from '@boardsesh/profile-stats';
import { getGradeColor, DEFAULT_GRADE_COLOR } from '@boardsesh/board-constants/grade-colors';
import {
  deriveGradeTokenModel,
  gradeTokenA11yLabel,
  logbookAttemptsKind,
  displayedAttemptCount,
  normalizeLogbookQuality,
  logbookNoteIsVisible,
} from '@boardsesh/logbook';
import { Text } from '../Text';
import { Icon } from '../Icon';
import { GradeValue } from '../grade/GradeValue';
import { type IconName } from '../icon-map';
import { ClimbAttributeIcons } from '../ClimbAttributeIcons';
import { useSwipeArm } from '../use-swipe-arm';
import { brandColors } from '../../theme/colors';
import { iosSystemColors } from '../../theme/ios-colors';
import { spacing } from '../../theme/tokens';
import { useTheme } from '../../providers/theme-provider';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { useBoardseshGradesActive } from '../../hooks/use-display-grade';
import { resolveCrowdDifficultyId, GRADE_BY_ID, clampDifficultyId } from '../../lib/boardsesh-grade-display';
import { renderBoardToPlaylistConfig } from '../../lib/playlists/board-details-for-playlist';
import { hapticSelection, hapticMedium, hapticLight, hapticSuccess } from '../../lib/haptics';

type LogbookRowProps = {
  ascent: AscentFeedItem;
  /** Tap → the row's primary action (logbook: activate + open play drawer). */
  onActivate: (ascent: AscentFeedItem) => void;
  /** Long press → open the climb actions sheet. Omit to disable long-press on a
   *  host that wants the row to be a plain selector. */
  onOpenActions?: (ascent: AscentFeedItem) => void;
  /** Swipe left-to-right → edit the logbook entry. Owner-only; when omitted the
   *  left swipe action is disabled (you can't edit another climber's ticks). */
  onEdit?: (ascent: AscentFeedItem, method: 'swipe' | 'a11y') => void;
  /**
   * Swipe right-to-left → delete the logbook entry, behind the host's confirm
   * dialog (DELETE_TICK is a real server-side, Aurora-synced delete). Owner-only;
   * when omitted the right swipe action is disabled. The ascent is captured at
   * commit time — the host must not re-read row state after its confirm awaits
   * (FlashList can recycle this row onto a different ascent meanwhile).
   * `method` reports how the delete was initiated, for analytics.
   */
  onDeleteRequest?: (ascent: AscentFeedItem, method: 'swipe' | 'a11y') => void;
  /**
   * Whether the meta line carries the BOARD name. The logbook tab passes false
   * when a divider or subdivider above already names the board; the angle
   * stays on the row either way (it varies per climb on adjustable boards and
   * disambiguates repeat ascents). Defaults to true so flat views never lose
   * the wall.
   */
  showBoardInMeta?: boolean;
  /**
   * Day-summed tries for a grouped row (same climb, same day collapsed).
   * Overrides the single entry's count; the best-outcome entry supplies
   * everything else on the row. Absent for ungrouped rows.
   */
  groupTries?: number;
  /**
   * Device font scale, passed by the host so a 50-row list holds ONE dimension
   * subscription (the tab's) instead of one per row — useWindowDimensions in a
   * memo'd row re-renders every visible row on any dimension event (keyboard,
   * rotation, split-screen). Defaults to 1 for hosts that don't scale.
   */
  fontScale?: number;
};

// Swipe tuning mirrors ClimbListRow: drag up to ACTION_REVEAL wide; dragging
// past COMMIT_THRESHOLD and releasing commits the action (no resting-open
// state). friction=1 tracks the finger 1:1.
const ACTION_REVEAL = 150;
const COMMIT_THRESHOLD = 96;
const SWIPE_FRICTION = 1;

// Meta-line width tiers (device fontScale). The Text primitive caps scaling at
// 1.5×, so 1.5 is the true worst case. Below DROP_TIME everything fits on one
// line; between the tiers the time-of-day (the lowest-value part) drops; at
// TWO_LINE the meta wraps to a results line + context line so nothing is lost.
// Whole parts drop — never character ellipsis mid-part (a "3★" cut to "3…"
// misreports the rating). Thresholds are a starting point, tuned on device.
const FONT_SCALE_DROP_TIME = 1.15;
const FONT_SCALE_TWO_LINE = 1.3;

// Status is the hero of a logbook entry — a bare ~22pt glyph, shape-first
// (⚡ flashed, ✓ sent, ○ project) with colour as reinforcement, replacing the
// search row's small trailing status glyph. Icon names are static; colours
// resolve per-scheme in the component.
const STATUS_ICON: Record<AscentFeedItem['status'], IconName> = {
  flash: 'flash',
  send: 'tick.outline',
  attempt: 'circle',
};
const STATUS_GLYPH_SIZE = 22;

/**
 * Drag-driven inner of a swipe action — the icon grows in with the drag plus a
 * haptic detent at the commit threshold. Only mounted while the row is being
 * dragged; the action itself fires from onSwipeableWillOpen.
 */
function SwipeActionInner({ translation, icon }: { translation: SharedValue<number>; icon: IconName }) {
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
      <Icon name={icon} size={24} color={iosSystemColors.white} />
    </Animated.View>
  );
}

/**
 * Swipe action shell (either side) — commit-on-release fires the action. Cheap
 * shell while resting; mounts the animated inner once a drag starts (`active`).
 * At translation=0 the icon is fully transparent, so the resting shell renders
 * no icon.
 */
function SwipeAction({
  translation,
  active,
  icon,
  side,
}: {
  translation: SharedValue<number>;
  active: boolean;
  icon: IconName;
  side: 'left' | 'right';
}) {
  return (
    <View style={[styles.swipeAction, side === 'left' ? styles.swipeActionLeft : styles.swipeActionRight]}>
      {active ? <SwipeActionInner translation={translation} icon={icon} /> : null}
    </View>
  );
}

export const LogbookRow = memo(function LogbookRow({
  ascent,
  onActivate,
  onOpenActions,
  onEdit,
  onDeleteRequest,
  showBoardInMeta = true,
  groupTries,
  fontScale = 1,
}: LogbookRowProps) {
  const { t, i18n } = useTranslation('you');
  const { systemColors, brandColors: brand } = useTheme();
  const { formatGrade, formatGradeByDifficultyId } = useGradeFormat();
  const boardseshActive = useBoardseshGradesActive();

  const statusColor =
    ascent.status === 'flash' ? brand.warning : ascent.status === 'send' ? brand.success : iosSystemColors.systemGray;

  // --- Grade column. ONE number, and a `people` marker only when that number
  // is the crowd's. This is a DIARY surface: it is about what YOU did, so your
  // own grade is the unremarkable one here and needs no glyph — the mirror of
  // the climbs list, where the crowd's number is the expected one.
  //
  // A climber's OWN logged grade (`ascent.difficulty`) always wins; the crowd
  // side is the only thing the app-wide "Show Boardsesh grades" toggle swaps —
  // the Boardsesh grade replaces the legacy community consensus as the crowd
  // grade when it's active, present and trusted (see resolveCrowdDifficultyId).
  // The crowd's number, when it differs, leads the meta line below rather than
  // stacking under this one.
  const crowdDifficulty = resolveCrowdDifficultyId(ascent, boardseshActive);
  const rawGradeLabel = ascent.difficultyName ?? ascent.consensusDifficultyName;
  const personalGradeLabel =
    ascent.difficulty != null
      ? (formatGradeByDifficultyId(ascent.difficulty) ?? formatGrade(ascent.difficultyName) ?? ascent.difficultyName)
      : null;
  const crowdGradeLabel =
    crowdDifficulty != null
      ? (formatGradeByDifficultyId(crowdDifficulty) ??
        formatGrade(ascent.consensusDifficultyName) ??
        ascent.consensusDifficultyName)
      : null;
  const gradeModel = deriveGradeTokenModel({
    personalLabel: personalGradeLabel,
    crowdLabel: crowdGradeLabel,
    baseline: 'personal',
  });
  // Colour the number actually shown: when the row is showing a crowd grade
  // (the Boardsesh grade when active), colour it from that grade's own
  // difficulty bucket rather than the legacy consensus name; the climber's own
  // logged-grade colour path is untouched.
  const gradeColorName =
    gradeModel.source === 'crowd' && crowdDifficulty != null
      ? (GRADE_BY_ID.get(clampDifficultyId(crowdDifficulty))?.difficulty_name ?? rawGradeLabel)
      : rawGradeLabel;
  const gradeColor = gradeColorName ? (getGradeColor(gradeColorName) ?? DEFAULT_GRADE_COLOR) : DEFAULT_GRADE_COLOR;

  // --- Meta line parts (review data — the climber's own record, not the
  // crowd's). Board+angle always renders: with no thumbnail it is the only
  // repeat-ascent disambiguator, and it must not mutate with the result set.
  const attemptsKind = logbookAttemptsKind(ascent.status);
  const triesShown = groupTries ?? displayedAttemptCount(ascent.attemptCount);
  // Display the effective quality so a Kilter-pulled tick (no per-tick quality)
  // surfaces the climber's own synced star rating. Edit still uses raw quality.
  const quality = normalizeLogbookQuality(ascent.effectiveQuality ?? ascent.quality);
  const hasNote = logbookNoteIsVisible(ascent.comment);
  const hasBetaVideo = ascent.hasBetaVideo === true;
  // The user-named board when the tick has one ("Garage Board"), else the
  // LAYOUT ("Kilter Homewall", "MoonBoard 2016") — a named board is personal
  // context worth keeping; unnamed ticks still get the wall product.
  const wallLabel = ascent.boardDisplayName ?? getLayoutDisplayName(ascent.boardType, ascent.layoutId);
  const boardAngleLabel = `${wallLabel} ${ascent.angle}°`;
  // A grouped flash day (flash + later repeats) still owns its summed tries —
  // "Flash · 5 tries" — while a plain flash stays a bare "Flash". Scoped to
  // grouped rows (groupTries != null): a lone imported flash tick carrying a
  // contradictory attemptCount > 1 must not grow a tries suffix in flat views.
  const flashShowsTries = groupTries != null && triesShown > 1;
  const attemptsLabel =
    attemptsKind === 'flash'
      ? flashShowsTries
        ? `${t('mobile.logbook.status.flash')} · ${t('mobile.logbook.tries', { count: triesShown })}`
        : t('mobile.logbook.status.flash')
      : attemptsKind === 'send'
        ? t('mobile.logbook.tries', { count: triesShown })
        : `${t('mobile.logbook.row.project')} · ${t('mobile.logbook.tries', { count: triesShown })}`;
  const starsLabel = quality != null ? t('mobile.logbook.row.stars', { count: quality }) : null;
  const timeLabel = useMemo(
    () =>
      parseTickTime(ascent.climbedAt)
        .toDate()
        .toLocaleTimeString(i18n.language, { hour: 'numeric', minute: '2-digit' }),
    [ascent.climbedAt, i18n.language],
  );

  const showTimeInline = fontScale < FONT_SCALE_DROP_TIME;
  const twoLineMeta = fontScale >= FONT_SCALE_TWO_LINE;
  // One line: results + context together, time dropping first under scale.
  // Two lines (accessibility sizes): results over context, nothing dropped.
  // Between the tiers (1.15–1.3) the time is INTENTIONALLY absent from the
  // visual layout — it's the lowest-value part and the a11y label still
  // speaks it; it returns in the context line once the two-line layout kicks in.
  const metaWall = showBoardInMeta ? boardAngleLabel : `${ascent.angle}°`;
  // The crowd's grade leads the meta run when it is not the number in the
  // column — one more grey fact about the climb, costing the row no height.
  const primaryMetaText = [gradeModel.crowdLineToken, attemptsLabel, twoLineMeta ? null : metaWall]
    .filter(Boolean)
    .join(' · ');
  const contextMetaText = twoLineMeta ? [metaWall, timeLabel].filter(Boolean).join(' · ') : null;

  // Rows whose board config can't resolve (frameless MoonBoard ticks) dead-end
  // in the play drawer today; keep the tap (analytics + a future detail view)
  // but don't fire a success haptic for a no-op.
  const actionable =
    !!ascent.frames && !!renderBoardToPlaylistConfig(ascent.boardType, ascent.layoutId, ascent.renderBoard);

  const swipeableRef = useRef<SwipeableMethods>(null);

  // Lazy swipe panels: the heavy animated inner only mounts once a drag actually
  // starts on this row (either side — the non-dragged side stays occluded by the
  // opaque row). The hook resets the machine on recycle (ascent.uuid).
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
  const onDeleteRequestRef = useRef(onDeleteRequest);
  onDeleteRequestRef.current = onDeleteRequest;
  const ascentRef = useRef(ascent);
  ascentRef.current = ascent;
  const actionableRef = useRef(actionable);
  actionableRef.current = actionable;

  const handleRowPress = useCallback(() => {
    if (actionableRef.current) hapticSelection();
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
    edit(ascentRef.current, 'swipe');
  }, []);

  // Capture the ascent NOW — the host's confirm dialog awaits, and FlashList can
  // recycle this row onto a different ascent while it's up. Deleting whatever
  // the ref points at after the await could delete the wrong tick.
  const handleDeleteRequest = useCallback(() => {
    const requestDelete = onDeleteRequestRef.current;
    if (!requestDelete) return;
    hapticMedium();
    requestDelete(ascentRef.current, 'swipe');
  }, []);

  // Snap shut once fully settled open (the action already fired on willOpen).
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
      // ReanimatedSwipeable reports the SWIPE direction, not the actions side:
      // 'right' fires when the LEFT actions (Edit) open (left-to-right swipe);
      // 'left' fires when the RIGHT actions (Delete) open (right-to-left).
      if (direction === 'right') handleEdit();
      else handleDeleteRequest();
    },
    [handleEdit, handleDeleteRequest],
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
  // no long-press handler the row is tap-only.
  const tapGesture = useMemo(
    () => (onOpenActions ? Gesture.Exclusive(longPressGesture, singleTapGesture) : singleTapGesture),
    [onOpenActions, longPressGesture, singleTapGesture],
  );

  // Read dragArmedRef.current rather than the armed state directly so these stay
  // dep-free: a changed render-callback reference makes ReanimatedSwipeable
  // re-create the action-panel subtree (remounting the heavy inner). The armed
  // state change re-renders the row, while the stable identity keeps the
  // shell→inner swap in place.
  const renderLeftActions = useCallback(
    (_progress: SharedValue<number>, translation: SharedValue<number>) => (
      <SwipeAction translation={translation} active={dragArmedRef.current} icon="edit" side="left" />
    ),
    [dragArmedRef],
  );
  const renderRightActions = useCallback(
    (_progress: SharedValue<number>, translation: SharedValue<number>) => (
      <SwipeAction translation={translation} active={dragArmedRef.current} icon="delete" side="right" />
    ),
    [dragArmedRef],
  );

  // --- Non-visual parity: the label reads as a log entry ("Sent X, V7, you
  // graded V7 community says V6, 3 tries, rated 3 of 5 stars, has note, ...")
  // and the swipe-only affordances are exposed as accessibility actions —
  // otherwise edit/delete are invisible to VoiceOver/TalkBack.
  const statusA11y =
    ascent.status === 'flash'
      ? t('mobile.logbook.row.a11yFlashed')
      : ascent.status === 'send'
        ? t('mobile.logbook.row.a11ySent')
        : t('mobile.logbook.row.project');
  // `gradeTokenA11yLabel` resolves its keys out of @boardsesh/logbook, which the
  // i18n orphan checker does not scan — so name them here:
  // i18n-keep common.mobile.gradeToken.a11yYours
  // i18n-keep common.mobile.gradeToken.a11yCommunity
  const gradeA11yLabel = gradeTokenA11yLabel(gradeModel, t);
  const accessibilityLabel = [
    `${statusA11y} ${ascent.climbName}`,
    gradeA11yLabel,
    gradeModel.crowdLineToken ? t('mobile.logbook.row.a11yCommunityGrade', { grade: gradeModel.crowdLineToken }) : null,
    attemptsKind === 'flash' && !flashShowsTries ? null : t('mobile.logbook.tries', { count: triesShown }),
    quality != null ? t('mobile.logbook.row.a11yStars', { count: quality }) : null,
    hasNote ? t('mobile.logbook.row.a11yHasNote') : null,
    hasBetaVideo ? t('mobile.logbook.row.a11yHasBetaVideo') : null,
    ascent.isMirror ? t('mobile.logbook.row.a11yMirrored') : null,
    boardAngleLabel,
    timeLabel,
  ]
    .filter(Boolean)
    .join(', ');

  const accessibilityActions = useMemo(() => {
    const actions: { name: string; label: string }[] = [];
    if (onEdit) actions.push({ name: 'edit', label: t('mobile.logbook.row.editAction') });
    if (onDeleteRequest) actions.push({ name: 'delete', label: t('mobile.logbook.row.deleteAction') });
    if (onOpenActions) actions.push({ name: 'more', label: t('mobile.logbook.row.moreActions') });
    return actions;
  }, [onEdit, onDeleteRequest, onOpenActions, t]);

  const handleAccessibilityAction = useCallback((event: AccessibilityActionEvent) => {
    const actionName = event.nativeEvent.actionName;
    if (actionName === 'edit') onEditRef.current?.(ascentRef.current, 'a11y');
    else if (actionName === 'delete') onDeleteRequestRef.current?.(ascentRef.current, 'a11y');
    else if (actionName === 'more') onOpenActionsRef.current?.(ascentRef.current);
  }, []);

  return (
    <View style={styles.outerContainer}>
      <ReanimatedSwipeable
        ref={swipeableRef}
        friction={SWIPE_FRICTION}
        leftThreshold={COMMIT_THRESHOLD}
        rightThreshold={COMMIT_THRESHOLD}
        overshootLeft={false}
        overshootRight={false}
        renderLeftActions={onEdit ? renderLeftActions : undefined}
        renderRightActions={onDeleteRequest ? renderRightActions : undefined}
        onSwipeableOpenStartDrag={handleSwipeStartDrag}
        onSwipeableWillOpen={handleSwipeWillOpen}
        onSwipeableOpen={handleSwipeableOpened}
        onSwipeableClose={handleSwipeableClosed}
      >
        {/* touchAction="pan-y" (web only): without it RNGH defaults the row's DOM
            node to `touch-action: none`, which blocks native touch-scrolling for
            any drag starting on the row — independent of ReanimatedSwipeable's own
            gesture, which already sets pan-y. Vertical drags fall through to the
            browser/list scroll; only horizontal ones reach this tap/long-press. */}
        <GestureDetector gesture={tapGesture} touchAction="pan-y">
          <View
            accessible
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityActions={accessibilityActions}
            onAccessibilityAction={handleAccessibilityAction}
            style={[styles.row, { backgroundColor: systemColors.secondaryBackground }]}
          >
            {/* Status — the hero of a log entry. Shape carries the meaning. */}
            <View style={styles.statusSlot}>
              <Icon name={STATUS_ICON[ascent.status]} size={STATUS_GLYPH_SIZE} color={statusColor} />
            </View>

            {/* Name + intrinsic attributes, then the review meta line(s). */}
            <View style={styles.centerColumn}>
              <View style={styles.nameRow}>
                <Text variant="body" numberOfLines={1} style={styles.climbName}>
                  {ascent.climbName}
                </Text>
                {/* ClimbAttributeIcons keys the © glyph on Number(value) > 0 and
                    never renders the value itself, so the '1' fallback only
                    forces the glyph on for a benchmark tick whose grade names
                    are missing — isBenchmark is authoritative here (the old
                    null fallback silently hid the glyph on those rows). */}
                <ClimbAttributeIcons
                  benchmarkDifficulty={
                    ascent.isBenchmark ? (ascent.consensusDifficultyName ?? ascent.difficultyName ?? '1') : null
                  }
                  isNoMatch={ascent.isNoMatch}
                />
                {ascent.isMirror ? (
                  <View style={styles.mirrorIcon}>
                    <Icon name="mirror" size={12} color={systemColors.secondaryLabel} />
                  </View>
                ) : null}
              </View>
              <View style={styles.metaRow}>
                <Text variant="footnote" color={systemColors.secondaryLabel} numberOfLines={1} style={styles.metaText}>
                  {primaryMetaText}
                </Text>
                {hasNote ? <Icon name="edit" size={11} color={systemColors.secondaryLabel} /> : null}
                {showTimeInline ? (
                  <Text variant="footnote" color={systemColors.tertiaryLabel}>
                    {timeLabel}
                  </Text>
                ) : null}
              </View>
              {contextMetaText ? (
                <Text variant="footnote" color={systemColors.tertiaryLabel} numberOfLines={1}>
                  {contextMetaText}
                </Text>
              ) : null}
            </View>

            {/* Grade slot — ONE number, one line. Your rating and the beta
                marker sit LEFT of it (review feedback: the meta line was too
                crowded to scan them); the crowd's number, when it differs, is
                the leading token of the meta line above rather than a second
                row here. flexShrink:0 so the title never squeezes the grade.

                No delta arrow: the two numbers are adjacent on an ordinal
                scale, so an arrow only restates what reading them already
                says — a third glyph family for nothing. */}
            <View style={styles.trailing}>
              {starsLabel ? (
                <Text variant="caption1" color={systemColors.secondaryLabel}>
                  {starsLabel}
                </Text>
              ) : null}
              {hasBetaVideo ? <Icon name="video.fill" size={13} color={brand.primary} /> : null}
              {gradeModel.source !== 'none' ? (
                <GradeValue
                  label={gradeModel.label}
                  color={gradeColor}
                  source={gradeModel.source}
                  baseline="personal"
                  accessibilityLabel={gradeA11yLabel ?? undefined}
                />
              ) : null}
            </View>
          </View>
        </GestureDetector>
      </ReanimatedSwipeable>
      <View style={[styles.separator, { backgroundColor: systemColors.separator }]} />
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
    paddingHorizontal: spacing[4],
    // Touch floor even for single-line rows at small type sizes.
    minHeight: 44,
  },
  statusSlot: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerColumn: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    gap: 2,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
  },
  climbName: {
    fontWeight: '600',
    // Shrink so the name (not the trailing attribute glyphs) absorbs truncation.
    flexShrink: 1,
  },
  mirrorIcon: {
    marginLeft: 4,
    flexShrink: 0,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: 4,
    minWidth: 0,
  },
  metaText: {
    flexShrink: 1,
  },
  trailing: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginLeft: spacing[2],
    maxWidth: 140,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    // Inset to the text column: row padding + status slot + column gap.
    marginLeft: spacing[4] + 28 + spacing[3],
  },
  swipeAction: {
    width: ACTION_REVEAL,
    justifyContent: 'center',
  },
  swipeActionLeft: {
    alignItems: 'flex-start',
    paddingLeft: 22,
    backgroundColor: brandColors.primary,
  },
  swipeActionRight: {
    alignItems: 'flex-end',
    paddingRight: 22,
    backgroundColor: brandColors.error,
  },
});
