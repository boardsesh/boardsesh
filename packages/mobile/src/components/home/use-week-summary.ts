import { useMemo } from 'react';
import dayjs from 'dayjs';
import { buildWeekSummary, type WeekSummary } from '@boardsesh/profile-stats';
import type { ActivityTick } from '../../db/queries/get-activity-ticks-local';
import { useGradeFormat } from '../../hooks/use-grade-format';
import { nowMs } from '../../lib/clock';
import { useActivityTicks } from './use-activity-ticks';

/**
 * Home's "This week" card, from the ticks on this phone (#7690). Undefined
 * while the local read loads, when nobody is signed in, or when the logbook on
 * the phone is not complete yet: see `useActivityTicks`.
 */
export function useWeekSummary(enabled: boolean): WeekSummary<ActivityTick> | undefined {
  const ticks = useActivityTicks(enabled);
  const { formatGradeByDifficultyId } = useGradeFormat();
  // The day the week is anchored on, read on each render, so a focus after
  // midnight on Sunday turns the card over.
  const todayKey = dayjs(nowMs()).format('YYYY-MM-DD');
  return useMemo(() => {
    if (!ticks) return undefined;
    return buildWeekSummary(ticks, {
      today: dayjs(todayKey).hour(12),
      gradeLabel: (difficulty, boardType) => formatGradeByDifficultyId(difficulty, boardType),
    });
  }, [ticks, todayKey, formatGradeByDifficultyId]);
}
