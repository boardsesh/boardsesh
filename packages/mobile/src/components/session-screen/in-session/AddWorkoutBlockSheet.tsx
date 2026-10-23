// "Add a block" during a session (#5379): pick a workout type, a grade and the
// counts, see the climbs it will add, and queue them behind the live queue
// the way Add to queue does, without moving the wall on this phone.
//
// A ModalSheet, not a route (docs/mobile-sheets-vs-routes.md): it is a short
// task over the session screen, opened by a button, and it opens no sheet of
// its own. Its preview lists every climb with the Record tab's rows (thumbnail,
// per-row refresh, the same section headings), but a row tap does nothing: the
// play drawer would open under the sheet.
//
// It reuses the pre-session generator end to end: the block card's fields with
// the workout types only (mid-session the climber is already warm, so no
// warm-up), `useWorkoutPreview` (planFromBlocks + generateStagedPlan + the
// shared pools), and the preview summary with Shuffle. The climbs already queued
// are passed over where the pool has others. The block uses the generator's
// default climb filters, not the ones the session was started with.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { BottomSheetFlatList } from '@expo/ui/community/bottom-sheet';
import { useTranslation } from 'react-i18next';
import { toBoardName } from '@boardsesh/board-config';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { summarizePlanFill, type GeneratorOptions, type WorkoutBlockSpec } from '@boardsesh/playlist-generator';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { Card } from '../../Card';
import { ModalSheet } from '../../ModalSheet';
import { SectionHeader } from '../../SectionHeader';
import { SheetTopBar } from '../../SheetTopBar';
import { Text } from '../../Text';
import { useTheme } from '../../../providers/theme-provider';
import { useAuth } from '../../../providers/auth-provider';
import { useQueueActions, useQueueSessionId } from '../../../providers/queue-provider';
import { useActiveBoard } from '../../../lib/graphql/use-active-board';
import {
  getWorkoutRunForSession,
  hydrateWorkoutRun,
  setWorkoutRun,
  useWorkoutRun,
} from '../../../lib/workout-run-store';
import { track } from '../../../lib/analytics';
import { hapticSuccess } from '../../../lib/haptics';
import { spacing } from '../../../theme/tokens';
import { getDefaultTargetGrade, toRailGrades } from '../pre-session/generator-controls';
import { WorkoutBlockFields } from '../pre-session/WorkoutBlockFields';
import { WorkoutPreviewListRow } from '../pre-session/WorkoutPreviewListRow';
import { WorkoutPreviewSummary } from '../pre-session/WorkoutPreviewSummary';
import { useWorkoutPreview } from '../pre-session/use-workout-preview';
import {
  NO_WORKOUT,
  WORKOUT_BLOCK_TYPES,
  buildDefaultOptions,
  singleBlockSelection,
  type GeneratorSelection,
  type WorkoutBlockType,
} from '../pre-session/workout-blocks';
import { buildPreviewListRows, type PreviewListRow } from '../pre-session/workout-preview-sections';
import type { QueueItemRowBoard } from '../../QueueItemRow';
import { addWorkoutBlock, defaultMidSessionBlock } from './add-workout-block';

/** Workout types only: mid-session the climber is already warm. */
export const ADD_BLOCK_TYPES: readonly WorkoutBlockType[] = WORKOUT_BLOCK_TYPES.filter((type) => type !== 'warmUp');
// Keys the one block this sheet edits. Stage ids are minted per plan, so a
// fixed id never reaches the run.
const ADD_BLOCK_ID = 'add-block';
const SNAP_POINTS = ['90%'];

function previewKeyExtractor(row: PreviewListRow): string {
  return row.key;
}

type AddWorkoutBlockSheetProps = {
  visible: boolean;
  onClose: () => void;
};

export const AddWorkoutBlockSheet = memo(function AddWorkoutBlockSheet({
  visible,
  onClose,
}: AddWorkoutBlockSheetProps) {
  const { t } = useTranslation('session');
  const { t: tCommon } = useTranslation('common');
  const { systemColors } = useTheme();
  const { isAuthenticated } = useAuth();
  const { sessionId } = useQueueSessionId();
  const { appendQueueItems, getQueueSnapshot } = useQueueActions();
  const { data: activeBoard } = useActiveBoard();
  const run = useWorkoutRun(sessionId);
  const boardName = activeBoard ? toBoardName(activeBoard.boardType) : null;
  const railGrades = useMemo(() => toRailGrades(boardName), [boardName]);

  // The block being edited. Null while the sheet is closed, so a closed sheet
  // builds no preview and fetches nothing. Seeded on every open from the run's
  // last stage, so it reflects the workout as it is now.
  const [options, setOptions] = useState<GeneratorOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set by the first "Add to session" of an opening. The body stays mounted
  // through the slide-down, so without it a second tap would queue the same
  // climbs again (a whole-queue write does not dedupe by uuid).
  const submittedRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const wasVisibleRef = useRef(false);
  const runRef = useRef(run);
  runRef.current = run;
  // Latest values for the confirm to re-check after it awaits the store.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      setOptions(defaultMidSessionBlock(runRef.current, getDefaultTargetGrade(boardName)));
      setError(null);
      submittedRef.current = false;
      setIsSubmitting(false);
    }
    wasVisibleRef.current = visible;
  }, [visible, boardName]);
  // Kept until the slide-down finishes, so the body doesn't empty mid-animation.
  const handleFullyDismissed = useCallback(() => setOptions(null), []);

  // The session ended (here or by the crew) while the sheet was open: there is
  // nothing left to add to.
  useEffect(() => {
    if (visible && sessionId === null) onClose();
  }, [visible, sessionId, onClose]);

  const selection = useMemo<GeneratorSelection>(
    () => (options ? singleBlockSelection(options, ADD_BLOCK_ID) : NO_WORKOUT),
    [options],
  );
  const block = useMemo<WorkoutBlockSpec | null>(() => (options ? { kind: 'workout', options } : null), [options]);
  // Read at build and shuffle time, never subscribed: a crew add mid-preview
  // must not rebuild what the climber is looking at.
  const getAvoidedClimbUuids = useCallback(() => {
    const queuedClimbUuids = new Set<string>();
    for (const queueItem of getQueueSnapshot().queue) {
      // A restored queue can carry an item whose climb has not resolved yet.
      const climb: ClimbQueueItem['climb'] | undefined = queueItem.climb;
      if (climb) queuedClimbUuids.add(climb.uuid);
    }
    return queuedClimbUuids;
  }, [getQueueSnapshot]);
  const {
    items,
    status,
    refreshingUuids,
    plannedCount,
    plannedSlots,
    plannedStages,
    refreshSlot,
    shuffle,
    toStagedQueueItems,
  } = useWorkoutPreview(selection, activeBoard ?? null, { isAuthenticated, getAvoidedClimbUuids });
  // A pyramid shows its way up and down, exactly as the Record tab would for one block.
  const previewRows = useMemo(() => buildPreviewListRows(items, plannedStages), [items, plannedStages]);
  const planSummary = useMemo(
    () =>
      summarizePlanFill(
        plannedSlots,
        items.map((previewItem) => previewItem.slot),
      ),
    [plannedSlots, items],
  );

  const handleTypeChange = useCallback((type: WorkoutBlockType) => {
    // Never offered here; a warm-up has nothing to ramp to after the live queue.
    if (type === 'warmUp') return;
    setError(null);
    setOptions((current) =>
      current && current.type !== type
        ? { ...buildDefaultOptions(type, current.targetGrade), warmUp: 'none' }
        : current,
    );
  }, []);
  const handleBlockChange = useCallback((next: WorkoutBlockSpec) => {
    if (next.kind !== 'workout') return;
    setError(null);
    setOptions(next.options);
  }, []);

  const isPreviewReady = status === 'ready' && items.length > 0 && refreshingUuids.size === 0;
  const canAdd =
    visible && !isSubmitting && sessionId !== null && activeBoard != null && options !== null && isPreviewReady;

  const handleAdd = useCallback(async () => {
    if (submittedRef.current || !canAdd || !options || !activeBoard || sessionId === null) return;
    const { items: stagedItems, run: blockRun } = toStagedQueueItems();
    if (stagedItems.length === 0 || !blockRun) return;
    submittedRef.current = true;
    setIsSubmitting(true);
    // A cold start may still be reading this session's run from storage. Reading
    // the store before it lands would see no run and overwrite the slot with
    // only this block, losing the workout queued at Start.
    await hydrateWorkoutRun(sessionId);
    if (!visibleRef.current || sessionIdRef.current !== sessionId) {
      submittedRef.current = false;
      setIsSubmitting(false);
      // The preview was built for the session that just left.
      if (visibleRef.current) onClose();
      return;
    }
    // Belt and braces for this path: never queue a uuid twice.
    const queuedUuids = new Set(getQueueSnapshot().queue.map((queueItem) => queueItem.uuid));
    const blockItems = stagedItems.filter((item) => !queuedUuids.has(item.uuid));
    if (blockItems.length === 0) {
      onClose();
      return;
    }
    const result = addWorkoutBlock({
      items: blockItems,
      blockRun,
      existingRun: getWorkoutRunForSession(sessionId),
      appendQueueItems,
    });
    if (result.landedCount === 0 || !result.run) {
      setError(t('mobile.session.addBlockQueueFull'));
      // Nothing was queued, so a retry after clearing climbs is safe.
      submittedRef.current = false;
      setIsSubmitting(false);
      return;
    }
    setWorkoutRun(sessionId, result.run);
    track(SHARED_EVENTS.SessionQueueGenerated, {
      // One block and never a warm-up, so both fields hold the same type here;
      // `phase` tells this add apart from a pre-session workout.
      workoutType: options.type,
      workoutTypes: options.type,
      boardName: activeBoard.boardType,
      angle: activeBoard.angle,
      savedCount: result.landedCount,
      failedCount: plannedCount - result.landedCount,
      stageCount: result.addedStageCount,
      phase: 'in_session',
    });
    hapticSuccess();
    onClose();
  }, [
    canAdd,
    options,
    activeBoard,
    sessionId,
    toStagedQueueItems,
    getQueueSnapshot,
    appendQueueItems,
    plannedCount,
    t,
    onClose,
  ]);
  const handleAddPress = useCallback(() => void handleAdd(), [handleAdd]);

  const title = t('mobile.session.addBlockTitle');
  const header = (
    <SheetTopBar
      title={title}
      leading={{ kind: 'close', onPress: onClose, accessibilityLabel: tCommon('actions.close') }}
      trailing={{
        kind: 'confirm',
        label: t('mobile.session.addBlockConfirm'),
        onPress: handleAddPress,
        disabled: !canAdd,
        loading: isSubmitting,
        prominent: true,
      }}
      error={error}
      reserveErrorSlot
    />
  );

  const previewStateMessage =
    items.length > 0
      ? null
      : status === 'loading'
        ? t('mobile.session.preWorkoutPreviewGenerating')
        : status === 'error'
          ? t('mobile.session.preWorkoutPreviewError')
          : status === 'ready'
            ? t('mobile.session.addBlockPreviewEmpty')
            : null;

  // Board context for the preview rows (thumbnails + grade colours).
  const previewBoard = useMemo<QueueItemRowBoard | null>(() => {
    if (!activeBoard || !boardName) return null;
    return {
      boardName,
      layoutId: activeBoard.layoutId,
      sizeId: activeBoard.sizeId,
      setIds: activeBoard.setIds,
      angle: activeBoard.angle,
    };
  }, [activeBoard, boardName]);
  // Primitives, so the list header keeps stable, length-free deps.
  const isRefreshingAnyRow = refreshingUuids.size > 0;
  const hasPreviewItems = items.length > 0;

  // No row is ever active and no onPress: a row tap would open the play drawer
  // under this sheet. The refresh button still regenerates its own climb, except
  // while Add to session runs: it has already taken the climbs it will queue.
  const renderPreviewRow = useCallback(
    ({ item: row }: { item: PreviewListRow }) => (
      <WorkoutPreviewListRow
        row={row}
        board={previewBoard}
        activeUuid={null}
        refreshingUuids={refreshingUuids}
        refreshLocked={isSubmitting}
        onRefresh={refreshSlot}
      />
    ),
    [previewBoard, refreshingUuids, isSubmitting, refreshSlot],
  );

  // Everything above the climbs scrolls with them, so the block's fields don't
  // pin half the sheet while the climber reads the list.
  const listHeader = useMemo(
    () => (
      <View style={styles.header} testID="add-workout-block-sheet">
        <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.inset}>
          {t('mobile.session.addBlockIntro')}
        </Text>

        {block ? (
          <View style={styles.inset}>
            <WorkoutBlockFields
              block={block}
              boardName={boardName}
              railGrades={railGrades}
              groupLabel={title}
              blockTypes={ADD_BLOCK_TYPES}
              onTypeChange={handleTypeChange}
              onBlockChange={handleBlockChange}
            />
          </View>
        ) : null}

        <View>
          <SectionHeader title={t('mobile.session.addBlockPreviewTitle')} />
          {boardName && hasPreviewItems ? (
            <WorkoutPreviewSummary
              summary={planSummary}
              boardName={boardName}
              onShuffle={shuffle}
              shuffleDisabled={status !== 'ready' || isRefreshingAnyRow || isSubmitting}
            />
          ) : null}
          {previewStateMessage ? (
            <View style={styles.inset}>
              <Card>
                <Text variant="body" color={systemColors.secondaryLabel}>
                  {previewStateMessage}
                </Text>
              </Card>
            </View>
          ) : null}
        </View>
      </View>
    ),
    [
      systemColors.secondaryLabel,
      t,
      block,
      boardName,
      railGrades,
      title,
      handleTypeChange,
      handleBlockChange,
      hasPreviewItems,
      planSummary,
      shuffle,
      status,
      isRefreshingAnyRow,
      isSubmitting,
      previewStateMessage,
    ],
  );

  // Not `scrollable`: the list is the sheet's scroll, inside the body ModalSheet
  // pads for the window's bottom inset, so the last row clears the home
  // indicator and the Android navigation bar.
  return (
    <ModalSheet
      visible={visible}
      snapPoints={SNAP_POINTS}
      onClose={onClose}
      onFullyDismissed={handleFullyDismissed}
      header={header}
    >
      <BottomSheetFlatList
        testID="add-workout-block-preview"
        style={styles.list}
        data={previewRows}
        renderItem={renderPreviewRow}
        keyExtractor={previewKeyExtractor}
        ListHeaderComponent={listHeader}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      />
    </ModalSheet>
  );
});

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: spacing[4],
  },
  // No horizontal padding: the SectionHeader brings its own 16pt gutter, and the
  // block fields sit in `inset`, whose padding their grade rail bleeds back out of.
  header: {
    paddingTop: spacing[2],
    gap: spacing[3],
  },
  inset: {
    paddingHorizontal: spacing[4],
  },
});
