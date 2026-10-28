'use client';

import React, { useCallback, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import FlashOnOutlined from '@mui/icons-material/FlashOnOutlined';
import CheckCircleOutlineOutlined from '@mui/icons-material/CheckCircleOutlineOutlined';
import RadioButtonUncheckedOutlined from '@mui/icons-material/RadioButtonUncheckedOutlined';
import { useTranslation } from 'react-i18next';
import type { SessionDetailTick } from '@boardsesh/shared-schema';
import {
  workoutBlockDetail,
  workoutBlockName,
  workoutClimbStatus,
  workoutTally,
  type SessionWorkoutRepOutcome,
} from '@boardsesh/workout-summary';
import StaticClimbList from '@/app/components/climb-list/static-climb-list';
import { themeTokens } from '@/app/theme/theme-config';
import type { BoardDetails, Climb } from '@/app/lib/types';
import type { WorkoutClimbEntry, WorkoutClimbGroup } from './session-workout';

type SessionWorkoutClimbsProps = {
  groups: WorkoutClimbGroup[];
  boardDetails: BoardDetails;
  boardDetailsByClimb: Record<string, BoardDetails>;
  unlinkedClimbUuids: ReadonlySet<string>;
  /** The tick rows under a climb: likes, comments, delete. */
  renderTicks: (ticks: SessionDetailTick[]) => React.ReactNode;
};

const headerSx = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 1,
  px: 2,
  pt: 2,
  pb: 1,
  borderBottom: 1,
  borderColor: 'divider',
} as const;

function RepGlyph({ rep }: { rep: SessionWorkoutRepOutcome }) {
  const { t } = useTranslation('session');
  if (rep === 'flash') return <FlashOnOutlined fontSize="small" color="success" titleAccess={t('workout.repFlash')} />;
  if (rep === 'send') {
    return <CheckCircleOutlineOutlined fontSize="small" color="primary" titleAccess={t('workout.repSend')} />;
  }
  return <RadioButtonUncheckedOutlined fontSize="small" color="disabled" titleAccess={t('workout.repAttempt')} />;
}

function GroupHeader({ group }: { group: WorkoutClimbGroup }) {
  const { t } = useTranslation('session');
  if (group.type === 'block') {
    const tally = workoutTally(group.stage.tally, t);
    return (
      <Box sx={headerSx} data-testid="session-workout-block">
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2" component="h3" fontWeight={600}>
            {workoutBlockName(group.stage, t)}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {workoutBlockDetail(group.stage, t)}
          </Typography>
        </Box>
        {tally && (
          <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'right', flexShrink: 0 }}>
            {tally}
          </Typography>
        )}
      </Box>
    );
  }
  return (
    <Box sx={headerSx} data-testid={`session-workout-${group.type}`}>
      <Typography variant="subtitle2" component="h3" fontWeight={600}>
        {group.type === 'offPlan' ? t('workout.offPlan') : t('summary.crew')}
      </Typography>
    </Box>
  );
}

function EntryExtra({
  entry,
  repsPerSet,
  renderTicks,
}: {
  entry: WorkoutClimbEntry;
  repsPerSet: number | null | undefined;
  renderTicks: (ticks: SessionDetailTick[]) => React.ReactNode;
}) {
  const { t } = useTranslation('session');
  const { workoutClimb, setNumber } = entry;
  if (!workoutClimb) return renderTicks(entry.ticks);

  const status = workoutClimbStatus(workoutClimb, setNumber ? repsPerSet : null, t);
  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 2, pb: entry.ticks.length > 0 ? 0 : 1 }}>
        {setNumber ? (
          <Typography variant="caption" color="text.secondary">
            {t('workout.setLabel', { number: setNumber })}
          </Typography>
        ) : null}
        <Typography variant="caption" fontWeight={600}>
          {status}
        </Typography>
        {setNumber ? (
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            {workoutClimb.reps.map((rep, index) => (
              <RepGlyph key={index} rep={rep} />
            ))}
          </Box>
        ) : null}
      </Box>
      {/* The set's or climb's own ticks, for likes, comments and delete. */}
      {entry.ticks.length > 0 ? renderTicks(entry.ticks) : null}
    </>
  );
}

function WorkoutGroupList({
  group,
  boardDetails,
  boardDetailsByClimb,
  unlinkedClimbUuids,
  renderTicks,
}: Omit<SessionWorkoutClimbsProps, 'groups'> & { group: WorkoutClimbGroup }) {
  const entryByKey = useMemo(() => new Map(group.entries.map((entry) => [entry.key, entry])), [group.entries]);
  const climbs = useMemo(() => group.entries.map((entry) => entry.climb), [group.entries]);
  const rowKeys = useMemo(() => group.entries.map((entry) => entry.key), [group.entries]);
  const dimmed = useMemo(
    () => new Set(group.entries.filter((entry) => entry.workoutClimb?.skipped).map((entry) => entry.key)),
    [group.entries],
  );
  const repsPerSet = group.type === 'block' ? group.stage.repsPerSet : null;
  const renderExtra = useCallback(
    (_climb: Climb, rowKey: string) => {
      const entry = entryByKey.get(rowKey);
      return entry ? <EntryExtra entry={entry} repsPerSet={repsPerSet} renderTicks={renderTicks} /> : null;
    },
    [entryByKey, repsPerSet, renderTicks],
  );

  return (
    <StaticClimbList
      header={<GroupHeader group={group} />}
      boardDetails={boardDetails}
      boardDetailsByClimb={boardDetailsByClimb}
      unlinkedClimbUuids={unlinkedClimbUuids}
      dimmedRowKeys={dimmed}
      rowKeys={rowKeys}
      climbs={climbs}
      virtualize={false}
      renderItemExtra={renderExtra}
    />
  );
}

/**
 * The Climbs list of a workout session: one section per block, then "Off plan"
 * and the crew. Every section maps its rows (no windowing): a workout holds at
 * most a few hundred climbs, and several window virtualizers stacked on one
 * page would each assume they start at the top.
 */
export default function SessionWorkoutClimbs({ groups, ...listProps }: SessionWorkoutClimbsProps) {
  return (
    <Box data-testid="session-workout-climbs">
      {groups.map((group) => (
        <WorkoutGroupList key={group.key} group={group} {...listProps} />
      ))}
      <Box sx={{ height: themeTokens.layout.bottomNavSpacer }} aria-hidden />
    </Box>
  );
}
