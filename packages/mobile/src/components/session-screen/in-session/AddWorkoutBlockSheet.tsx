// "Add a block" during a session (#5379): pick a workout type, a grade and the
// counts, see the climbs it will add, and queue them behind the live queue
// the way Add to queue does, without moving the wall on this phone.
//
// A ModalSheet, not a route (docs/mobile-sheets-vs-routes.md): it is a short
// task over the session screen, opened by a button, and it opens no sheet of
// its own. Preview rows are text, not the tappable rows the Record tab uses, so
// nothing in it can push the player over the sheet.
//
// It reuses the pre-session generator end to end: the block card's fields with
// the workout types only (mid-session the climber is already warm, so no
// warm-up), `useWorkoutPreview` (planFromBlocks + generateStagedPlan + the
// shared pools), and the preview summary with Shuffle. The climbs already queued
// are passed over where the pool has others. The block uses the generator's
// default climb filters, not the ones the session was started with.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { toBoardName } from '@boardsesh/board-config';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { summarizePlanFill, type GeneratorOptions, type WorkoutBlockSpec } from '@boardsesh/playlist-generator';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { BoardName } from '@boardsesh/shared-schema';
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
import { useGradeFormat } from '../../../hooks/use-grade-format';
import { track } from '../../../lib/analytics';
import { hapticSuccess } from '../../../lib/haptics';
import { spacing } from '../../../theme/tokens';
import { getDefaultTargetGrade, toRailGrades } from '../pre-session/generator-controls';
import { WorkoutBlockFields } from '../pre-session/WorkoutBlockFields';
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
import type { PreviewItem } from '../pre-session/workout-preview-pool';
import { addWorkoutBlock, defaultMidSessionBlock } from './add-workout-block';

/** Climbs listed by name before the rest fold into "and N more". */
export const ADD_BLOCK_PREVIEW_ROWS = 5;

/** Workout types only: mid-session the climber is already warm. */
export const ADD_BLOCK_TYPES: readonly WorkoutBlockType[] = WORKOUT_BLOCK_TYPES.filter((type) => type !== 'warmUp');
// Keys the one block this sheet edits. Stage ids are minted per plan, so a
// fixed id never reaches the run.
const ADD_BLOCK_ID = 'add-block';
const SNAP_POINTS = ['90%'];

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
  const { items, status, refreshingUuids, plannedCount, plannedSlots, shuffle, toStagedQueueItems } = useWorkoutPreview(
    selection,
    activeBoard ?? null,
    { isAuthenticated, getAvoidedClimbUuids },
  );
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

  return (
    <ModalSheet
      visible={visible}
      snapPoints={SNAP_POINTS}
      onClose={onClose}
      onFullyDismissed={handleFullyDismissed}
      scrollable
      header={header}
    >
      <View style={styles.body} testID="add-workout-block-sheet">
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
          {boardName && items.length > 0 ? (
            <>
              <WorkoutPreviewSummary
                summary={planSummary}
                boardName={boardName}
                onShuffle={shuffle}
                shuffleDisabled={status !== 'ready' || refreshingUuids.size > 0}
              />
              <AddBlockPreviewList items={items} boardName={boardName} />
            </>
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
    </ModalSheet>
  );
});

/**
 * The first few climbs by name and grade, then a count of the rest. Bounded to
 * `ADD_BLOCK_PREVIEW_ROWS` rows, so it maps instead of virtualising.
 */
function AddBlockPreviewList({ items, boardName }: { items: readonly PreviewItem[]; boardName: BoardName }) {
  const { t } = useTranslation('session');
  const { systemColors } = useTheme();
  const { formatGrade } = useGradeFormat();
  const hiddenCount = items.length - ADD_BLOCK_PREVIEW_ROWS;
  return (
    <View style={[styles.inset, styles.previewList]} testID="add-workout-block-preview">
      {items.slice(0, ADD_BLOCK_PREVIEW_ROWS).map(({ item }) => (
        <View key={item.uuid} style={styles.previewRow}>
          <Text variant="body" numberOfLines={1} style={styles.previewName}>
            {item.climb.name}
          </Text>
          <Text variant="subheadline" color={systemColors.secondaryLabel} numeric>
            {formatGrade(item.climb.difficulty, boardName) ?? item.climb.difficulty}
          </Text>
        </View>
      ))}
      {hiddenCount > 0 ? (
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {t('mobile.session.addBlockPreviewMore', { count: hiddenCount })}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // No horizontal padding: the SectionHeader brings its own 16pt gutter, and the
  // block fields sit in `inset`, whose padding their grade rail bleeds back out of.
  body: {
    paddingTop: spacing[2],
    paddingBottom: spacing[4],
    gap: spacing[3],
  },
  inset: {
    paddingHorizontal: spacing[4],
  },
  previewList: {
    marginTop: spacing[2],
    gap: spacing[2],
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
  },
  previewName: {
    flex: 1,
  },
});
