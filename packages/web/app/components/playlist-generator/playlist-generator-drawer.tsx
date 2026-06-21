'use client';

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import CircularProgress from '@mui/material/CircularProgress';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import MuiButton from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import { ArrowBackOutlined, ElectricBoltOutlined } from '@mui/icons-material';
import type { BoardDetails, Climb } from '@/app/lib/types';
import { executeGraphQL } from '@/app/lib/graphql/client';
import {
  type ClimbSearchInputVariables,
  type ClimbSearchResponse,
  SEARCH_CLIMBS,
} from '@boardsesh/graphql/operations/climb-search';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { normalizeMinRatingFilter } from '@/app/lib/climb-quality-filter-options';
import { track } from '@/app/lib/analytics';
import { type WorkoutType, type GeneratorOptions, type PlannedClimbSlot, WORKOUT_TYPES } from './types';
import WorkoutTypeSelector from './workout-type-selector';
import GeneratorOptionsForm, { getDefaultOptions } from './generator-options-form';
import GradeProgressionChart from './grade-progression-chart';
import { generateWorkoutPlan, groupSlotsBySection, getGradeName } from './generation-utils';
import styles from './playlist-generator-drawer.module.css';

export type GeneratorCompletionResult = {
  added: number;
  failed: number;
  total: number;
  /** Workout type the user picked. Useful for downstream analytics. */
  workoutType: WorkoutType;
};

/** Tag attached to every analytics event so we can split funnels by where
 *  the generated climbs end up (a playlist mutation vs the session queue). */
export type GeneratorTargetType = 'playlist' | 'session';

type PlaylistGeneratorDrawerProps = {
  open: boolean;
  onClose: () => void;
  boardDetails: BoardDetails;
  defaultAngle: number;
  onAddClimb: (climb: Climb, slot: PlannedClimbSlot, angle: number) => Promise<void>;
  onComplete?: (result: GeneratorCompletionResult) => void;
  targetType: GeneratorTargetType;
};

type DrawerState = 'select' | 'configure' | 'generating';

const PlaylistGeneratorDrawer: React.FC<PlaylistGeneratorDrawerProps> = ({
  open,
  onClose,
  boardDetails,
  defaultAngle,
  onAddClimb,
  onComplete,
  targetType,
}) => {
  const { token, isAuthenticated } = useWsAuthToken();
  const { showMessage } = useSnackbar();
  const { t } = useTranslation('playlists');

  const defaultTargetGrade = 18; // 6b/V4

  const [drawerState, setDrawerState] = useState<DrawerState>('select');
  const [selectedType, setSelectedType] = useState<WorkoutType | null>(null);
  const [options, setOptions] = useState<GeneratorOptions | null>(null);
  const [targetAngle, setTargetAngle] = useState<number>(defaultAngle);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  // Tracks whether the user reached the end of a generation run during this
  // open session. Lets us distinguish "closed before running anything"
  // (cancellation) from "closed after the run finished" (no extra event).
  // A 0-climbs run still counts as completed — we already fired a
  // `Workout Generated` event for that path; firing `Cancelled` on top
  // would double-count the same outcome.
  const runCompletedRef = useRef(false);

  useEffect(() => {
    if (open) {
      setDrawerState('select');
      setSelectedType(null);
      setOptions(null);
      setTargetAngle(defaultAngle);
      setGenerating(false);
      setProgress({ current: 0, total: 0 });
      runCompletedRef.current = false;
      track('Workout Generator Opened', {
        targetType,
        boardName: boardDetails.board_name,
        angle: defaultAngle,
      });
    }
  }, [open, defaultAngle, targetType, boardDetails.board_name]);

  const plannedSlots = useMemo(() => {
    if (!options) return [];
    return generateWorkoutPlan(options, boardDetails.board_name);
  }, [options, boardDetails.board_name]);

  const handleTypeSelect = useCallback(
    (type: WorkoutType) => {
      setSelectedType(type);
      setOptions(getDefaultOptions(type, defaultTargetGrade));
      setDrawerState('configure');
      track('Workout Type Selected', {
        targetType,
        workoutType: type,
        boardName: boardDetails.board_name,
      });
    },
    [defaultTargetGrade, targetType, boardDetails.board_name],
  );

  const handleBack = useCallback(() => {
    if (drawerState === 'configure') {
      track('Workout Generator Back Clicked', {
        targetType,
        workoutType: selectedType,
        boardName: boardDetails.board_name,
      });
      setDrawerState('select');
      setSelectedType(null);
      setOptions(null);
    }
  }, [drawerState, targetType, selectedType, boardDetails.board_name]);

  // Wrap onClose so dismissals before any generation run fire a cancellation
  // event. The generating phase blocks dismissal via the
  // `onClose={generating ? undefined : ...}` guard below — but both the
  // workout-type-select screen and the configure screen are dismissable.
  //
  // `workoutType` is omitted when the user dismisses from the select screen
  // (no type picked yet). Emitting `null` would widen the event's property
  // type and trip downstream dashboards that assume the property is always
  // a valid `WorkoutType`. Treat absence as absence.
  const handleClose = useCallback(() => {
    if (!generating && !runCompletedRef.current) {
      track('Workout Generator Cancelled', {
        targetType,
        ...(selectedType ? { workoutType: selectedType } : {}),
        stage: drawerState,
        boardName: boardDetails.board_name,
      });
    }
    onClose();
  }, [drawerState, generating, targetType, selectedType, boardDetails.board_name, onClose]);

  const handleReset = useCallback(() => {
    if (selectedType) {
      setOptions(getDefaultOptions(selectedType, defaultTargetGrade));
      setTargetAngle(defaultAngle);
    }
  }, [selectedType, defaultTargetGrade, defaultAngle]);

  const searchClimbsForGrade = useCallback(
    async (grade: number, excludeUuids: Set<string>): Promise<Climb[]> => {
      const input: ClimbSearchInputVariables['input'] = {
        boardName: boardDetails.board_name,
        layoutId: boardDetails.layout_id,
        sizeId: boardDetails.size_id,
        setIds: boardDetails.set_ids.join(','),
        angle: targetAngle,
        minGrade: grade,
        maxGrade: grade,
        minAscents: options?.minAscents ?? 5,
        minRating: normalizeMinRatingFilter(options?.minRating) || undefined,
        sortBy: 'quality',
        sortOrder: 'desc',
        page: 1,
        pageSize: 50,
        onlyTallClimbs: options?.onlyTallClimbs || false,
        onlyWideClimbs: options?.onlyWideClimbs || false,
      };

      if (options && isAuthenticated) {
        switch (options.climbBias) {
          case 'unfamiliar':
            input.hideAttempted = true;
            input.hideCompleted = true;
            break;
          case 'attempted':
            input.showOnlyAttempted = true;
            break;
        }
      }

      const response = await executeGraphQL<ClimbSearchResponse, ClimbSearchInputVariables>(
        SEARCH_CLIMBS,
        { input },
        token,
      );

      return response.searchClimbs.climbs.filter((c) => !excludeUuids.has(c.uuid));
    },
    [boardDetails, targetAngle, options, isAuthenticated, token],
  );

  const handleGenerate = useCallback(async () => {
    if (!options || plannedSlots.length === 0 || !selectedType) {
      showMessage(t('generator.messages.noClimbs'), 'error');
      return;
    }

    // Snapshot the option set as flat scalars so the analytics events stay
    // queryable without unpacking nested JSON downstream.
    const optionsSnapshot: Record<string, string | number | boolean | null> = {
      workoutType: selectedType,
      targetGrade: options.targetGrade,
      targetAngle,
      warmUp: options.warmUp,
      minAscents: options.minAscents,
      minRating: options.minRating,
      climbBias: options.climbBias,
      onlyTallClimbs: !!options.onlyTallClimbs,
      onlyWideClimbs: !!options.onlyWideClimbs,
    };
    switch (options.type) {
      case 'volume':
        optionsSnapshot.mainSetClimbs = options.mainSetClimbs;
        optionsSnapshot.mainSetVariability = options.mainSetVariability;
        break;
      case 'pyramid':
      case 'ladder':
        optionsSnapshot.numberOfSteps = options.numberOfSteps;
        optionsSnapshot.climbsPerStep = options.climbsPerStep;
        break;
      case 'gradeFocus':
        optionsSnapshot.numberOfClimbs = options.numberOfClimbs;
        break;
    }

    track('Workout Generator Generate Clicked', {
      targetType,
      boardName: boardDetails.board_name,
      plannedCount: plannedSlots.length,
      ...optionsSnapshot,
    });

    const startedAt = performance.now();

    setGenerating(true);
    setDrawerState('generating');
    setProgress({ current: 0, total: plannedSlots.length });

    const addedUuids = new Set<string>();
    const failedSlots: PlannedClimbSlot[] = [];
    const climbCache = new Map<number, Climb[]>();

    let processed = 0;

    for (const slot of plannedSlots) {
      try {
        let availableClimbs = climbCache.get(slot.grade);
        if (!availableClimbs) {
          availableClimbs = await searchClimbsForGrade(slot.grade, addedUuids);
          climbCache.set(slot.grade, availableClimbs);
        } else {
          availableClimbs = availableClimbs.filter((c) => !addedUuids.has(c.uuid));
          climbCache.set(slot.grade, availableClimbs);
        }

        if (availableClimbs.length === 0) {
          failedSlots.push(slot);
          processed++;
          setProgress({ current: processed, total: plannedSlots.length });
          continue;
        }

        const poolSize = Math.min(5, availableClimbs.length);
        const selectedIndex = Math.floor(Math.random() * poolSize);
        const selectedClimb = availableClimbs[selectedIndex];

        await onAddClimb(selectedClimb, slot, targetAngle);

        addedUuids.add(selectedClimb.uuid);

        const updatedCache = (climbCache.get(slot.grade) || []).filter((c) => c.uuid !== selectedClimb.uuid);
        climbCache.set(slot.grade, updatedCache);
      } catch (error) {
        console.error('Error adding climb:', error);
        failedSlots.push(slot);
      }

      processed++;
      setProgress({ current: processed, total: plannedSlots.length });
    }

    setGenerating(false);

    const added = plannedSlots.length - failedSlots.length;
    // Any reached-the-end-of-loop counts as a completed run, even when 0
    // climbs were saved. We fire `Workout Generated` (below) with
    // savedCount=0 for that outcome; firing `Cancelled` from the
    // subsequent onClose would double-count it.
    runCompletedRef.current = true;
    const durationMs = Math.round(performance.now() - startedAt);

    track('Workout Generated', {
      targetType,
      boardName: boardDetails.board_name,
      plannedCount: plannedSlots.length,
      savedCount: added,
      failedCount: failedSlots.length,
      durationMs,
      ...optionsSnapshot,
    });

    onComplete?.({ added, failed: failedSlots.length, total: plannedSlots.length, workoutType: selectedType });
    onClose();
  }, [
    options,
    plannedSlots,
    selectedType,
    targetAngle,
    targetType,
    boardDetails.board_name,
    onAddClimb,
    onComplete,
    onClose,
    showMessage,
    searchClimbsForGrade,
    t,
  ]);

  const workoutTypeInfo = selectedType ? WORKOUT_TYPES.find((wt) => wt.type === selectedType) : null;

  const renderTitle = () => {
    if (drawerState === 'select') {
      return t('generator.drawerTitle');
    }
    if (drawerState === 'generating') {
      return t('generator.generatingTitle');
    }
    return workoutTypeInfo ? t(`generator.workoutTypes.${workoutTypeInfo.type}.name`) : t('generator.optionsTitle');
  };

  const renderContent = () => {
    if (drawerState === 'select') {
      return <WorkoutTypeSelector onSelect={handleTypeSelect} />;
    }

    if (drawerState === 'generating') {
      return (
        <div className={styles.generatingContainer}>
          <CircularProgress size={48} />
          <Typography variant="body2" component="span" className={styles.generatingText}>
            {t('generator.generatingProgress', { current: progress.current, total: progress.total })}
          </Typography>
        </div>
      );
    }

    if (drawerState === 'configure' && selectedType && options) {
      const groupedSlots = groupSlotsBySection(plannedSlots);

      return (
        <div className={styles.configureContainer}>
          <div className={styles.chartSection}>
            <GradeProgressionChart plannedSlots={plannedSlots} boardDetails={boardDetails} height={140} />
          </div>

          <div className={styles.summarySection}>
            {groupedSlots.map((group) => {
              const firstGrade = group.slots[0].grade;
              const lastGrade = group.slots[group.slots.length - 1].grade;
              const range =
                firstGrade === lastGrade
                  ? getGradeName(firstGrade, boardDetails.board_name)
                  : `${getGradeName(firstGrade, boardDetails.board_name)} - ${getGradeName(
                      lastGrade,
                      boardDetails.board_name,
                    )}`;
              return (
                <div key={group.section} className={styles.summaryRow}>
                  <Typography variant="body2" component="span" color="text.secondary">
                    {t(`generator.sections.${group.section}`)}
                  </Typography>
                  <Typography variant="body2" component="span">
                    {t('generator.summaryRow', { count: group.slots.length, range })}
                  </Typography>
                </div>
              );
            })}
            <div className={styles.totalRow}>
              <Typography variant="body2" component="span" fontWeight={600}>
                {t('generator.totals.total')}
              </Typography>
              <Typography variant="body2" component="span" fontWeight={600}>
                {t('generator.totals.climbs', { count: plannedSlots.length })}
              </Typography>
            </div>
          </div>

          <div className={styles.optionsSection}>
            <GeneratorOptionsForm
              workoutType={selectedType}
              options={options}
              onChange={setOptions}
              onReset={handleReset}
              boardDetails={boardDetails}
              targetAngle={targetAngle}
              onTargetAngleChange={setTargetAngle}
            />
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <SwipeableDrawer
      title={
        <div className={styles.drawerHeader}>
          {drawerState === 'configure' && (
            <MuiButton
              variant="text"
              startIcon={<ArrowBackOutlined />}
              onClick={handleBack}
              className={styles.backButton}
            />
          )}
          <span className={styles.drawerTitle}>{renderTitle()}</span>
          {drawerState === 'configure' && <div className={styles.headerSpacer} />}
        </div>
      }
      open={open}
      onClose={generating ? undefined : handleClose}
      placement="bottom"
      showCloseButton={!generating}
      disableBackdropClick={generating}
      styles={{
        wrapper: { height: '85vh' },
        header: {
          borderBottom: `1px solid var(--neutral-200)`,
        },
        body: {
          padding: drawerState === 'select' ? 0 : '16px',
          overflow: 'auto',
        },
      }}
      extra={
        drawerState === 'configure' && !generating ? (
          <MuiButton
            variant="contained"
            startIcon={<ElectricBoltOutlined />}
            onClick={handleGenerate}
            disabled={plannedSlots.length === 0}
          >
            {t('generator.generate')}
          </MuiButton>
        ) : null
      }
    >
      {renderContent()}
    </SwipeableDrawer>
  );
};

export default PlaylistGeneratorDrawer;
