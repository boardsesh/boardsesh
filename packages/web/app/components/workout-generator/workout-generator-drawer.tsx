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
} from '@/app/lib/graphql/operations/climb-search';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { normalizeMinRatingFilter } from '@/app/lib/climb-quality-filter-options';
import { track } from '@/app/lib/analytics';
import { type WorkoutType, type GeneratorOptions, type PlannedClimbSlot, WORKOUT_TYPES } from './types';
import WorkoutTypeSelector from './workout-type-selector';
import GeneratorOptionsForm, { getDefaultOptions } from './generator-options-form';
import GradeProgressionChart from './grade-progression-chart';
import { generateWorkoutPlan, groupSlotsBySection, getGradeName } from './generation-utils';
import styles from './workout-generator-drawer.module.css';

/**
 * Per-climb save target. The drawer hands each generated climb to `saveClimb`
 * in order; throwing is treated as "this slot failed" and falls through to the
 * partial-success path. `onComplete` fires once after the run finishes (success
 * or partial).
 */
export type GeneratorTarget = {
  saveClimb: (climb: Climb, slot: PlannedClimbSlot) => Promise<void>;
  onComplete?: (savedClimbs: Climb[], meta: { failed: number; total: number; workoutType: WorkoutType }) => void;
};

export type GeneratorTargetType = 'playlist' | 'session';

type WorkoutGeneratorDrawerProps = {
  open: boolean;
  onClose: () => void;
  boardDetails: BoardDetails;
  angle: number;
  target: GeneratorTarget;
  /** Tagged on every analytics event so we can split funnels by destination. */
  targetType: GeneratorTargetType;
};

type DrawerState = 'select' | 'configure' | 'generating';

const WorkoutGeneratorDrawer: React.FC<WorkoutGeneratorDrawerProps> = ({
  open,
  onClose,
  boardDetails,
  angle,
  target,
  targetType,
}) => {
  const { token, isAuthenticated } = useWsAuthToken();
  const { showMessage } = useSnackbar();
  const { t } = useTranslation('generator');

  const defaultTargetGrade = 18;

  const [drawerState, setDrawerState] = useState<DrawerState>('select');
  const [selectedType, setSelectedType] = useState<WorkoutType | null>(null);
  const [options, setOptions] = useState<GeneratorOptions | null>(null);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  // Tracks whether the user actually generated something; lets us distinguish
  // "closed the drawer mid-configure" from "closed after a successful run" for
  // the cancellation event.
  const completedSuccessfullyRef = useRef(false);

  useEffect(() => {
    if (open) {
      setDrawerState('select');
      setSelectedType(null);
      setOptions(null);
      setGenerating(false);
      setProgress({ current: 0, total: 0 });
      completedSuccessfullyRef.current = false;
      track('Workout Generator Opened', {
        targetType,
        boardName: boardDetails.board_name,
        angle,
      });
    }
  }, [open, targetType, boardDetails.board_name, angle]);

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

  const handleReset = useCallback(() => {
    if (selectedType) {
      setOptions(getDefaultOptions(selectedType, defaultTargetGrade));
    }
  }, [selectedType, defaultTargetGrade]);

  // Wrap onClose so we can fire a cancellation event when the user closes
  // before completing a run (configure state, not currently generating, not
  // post-success). Same wrapper is also bound to the swipeable drawer's close.
  const handleClose = useCallback(() => {
    if (drawerState === 'configure' && !generating && !completedSuccessfullyRef.current) {
      track('Workout Generator Cancelled', {
        targetType,
        workoutType: selectedType,
        stage: 'configure',
        boardName: boardDetails.board_name,
      });
    }
    onClose();
  }, [drawerState, generating, targetType, selectedType, boardDetails.board_name, onClose]);

  const searchClimbsForGrade = useCallback(
    async (grade: number, excludeUuids: Set<string>): Promise<Climb[]> => {
      const input: ClimbSearchInputVariables['input'] = {
        boardName: boardDetails.board_name,
        layoutId: boardDetails.layout_id,
        sizeId: boardDetails.size_id,
        setIds: boardDetails.set_ids.join(','),
        angle,
        minGrade: grade,
        maxGrade: grade,
        minAscents: options?.minAscents ?? 5,
        minRating: normalizeMinRatingFilter(options?.minRating) || undefined,
        sortBy: 'quality',
        sortOrder: 'desc',
        page: 1,
        pageSize: 50,
        onlyTallClimbs: options?.onlyTallClimbs || false,
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
    [boardDetails, angle, options, isAuthenticated, token],
  );

  const handleGenerate = useCallback(async () => {
    if (!options || plannedSlots.length === 0 || !selectedType) {
      showMessage(t('messages.noClimbs'), 'error');
      return;
    }

    const optionsSnapshot: Record<string, string | number | boolean | null> = {
      workoutType: selectedType,
      targetGrade: options.targetGrade,
      warmUp: options.warmUp,
      minAscents: options.minAscents,
      minRating: options.minRating,
      climbBias: options.climbBias,
      onlyTallClimbs: !!options.onlyTallClimbs,
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
      angle,
      plannedCount: plannedSlots.length,
      ...optionsSnapshot,
    });

    const startedAt = performance.now();

    setGenerating(true);
    setDrawerState('generating');
    setProgress({ current: 0, total: plannedSlots.length });

    const addedUuids = new Set<string>();
    const savedClimbs: Climb[] = [];
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

        await target.saveClimb(selectedClimb, slot);

        addedUuids.add(selectedClimb.uuid);
        savedClimbs.push(selectedClimb);

        const updatedCache = (climbCache.get(slot.grade) || []).filter((c) => c.uuid !== selectedClimb.uuid);
        climbCache.set(slot.grade, updatedCache);
      } catch (error) {
        console.error('Error saving generated climb:', error);
        failedSlots.push(slot);
      }

      processed++;
      setProgress({ current: processed, total: plannedSlots.length });
    }

    setGenerating(false);
    completedSuccessfullyRef.current = savedClimbs.length > 0;

    const durationMs = Math.round(performance.now() - startedAt);

    track('Workout Generated', {
      targetType,
      boardName: boardDetails.board_name,
      angle,
      plannedCount: plannedSlots.length,
      savedCount: savedClimbs.length,
      failedCount: failedSlots.length,
      durationMs,
      ...optionsSnapshot,
    });

    if (failedSlots.length === 0) {
      showMessage(t('messages.addedAll', { count: plannedSlots.length }), 'success');
    } else if (failedSlots.length < plannedSlots.length) {
      showMessage(
        t('messages.addedPartial', {
          added: plannedSlots.length - failedSlots.length,
          failed: failedSlots.length,
        }),
        'warning',
      );
    } else {
      showMessage(t('messages.failed'), 'error');
    }

    target.onComplete?.(savedClimbs, {
      failed: failedSlots.length,
      total: plannedSlots.length,
      workoutType: selectedType,
    });
    onClose();
  }, [
    options,
    plannedSlots,
    selectedType,
    targetType,
    boardDetails.board_name,
    angle,
    target,
    onClose,
    showMessage,
    searchClimbsForGrade,
    t,
  ]);

  const workoutTypeInfo = selectedType ? WORKOUT_TYPES.find((wt) => wt.type === selectedType) : null;

  const renderTitle = () => {
    if (drawerState === 'select') {
      return t('drawerTitle');
    }
    if (drawerState === 'generating') {
      return t('generatingTitle');
    }
    return workoutTypeInfo ? t(`workoutTypes.${workoutTypeInfo.type}.name`) : t('optionsTitle');
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
            {t('generatingProgress', { current: progress.current, total: progress.total })}
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
                    {t(`sections.${group.section}`)}
                  </Typography>
                  <Typography variant="body2" component="span">
                    {t('summaryRow', { count: group.slots.length, range })}
                  </Typography>
                </div>
              );
            })}
            <div className={styles.totalRow}>
              <Typography variant="body2" component="span" fontWeight={600}>
                {t('totals.total')}
              </Typography>
              <Typography variant="body2" component="span" fontWeight={600}>
                {t('totals.climbs', { count: plannedSlots.length })}
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
          padding: drawerState === 'select' ? 0 : 16,
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
            {t('generate')}
          </MuiButton>
        ) : null
      }
    >
      {renderContent()}
    </SwipeableDrawer>
  );
};

export default WorkoutGeneratorDrawer;
