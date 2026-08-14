'use client';

import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Skeleton from '@mui/material/Skeleton';
import FlagOutlined from '@mui/icons-material/FlagOutlined';
import NotesOutlined from '@mui/icons-material/NotesOutlined';
import TimerOutlined from '@mui/icons-material/TimerOutlined';
import FlashOnOutlined from '@mui/icons-material/FlashOnOutlined';
import CheckCircleOutlineOutlined from '@mui/icons-material/CheckCircleOutlineOutlined';
import ErrorOutlineOutlined from '@mui/icons-material/ErrorOutlineOutlined';
import type { SessionGradeDistributionItem } from '@boardsesh/shared-schema';
import { CssBarChart } from '@/app/components/charts/css-bar-chart';
import { buildSessionGradeBars, SESSION_GRADE_LEGEND } from '@/app/components/charts/session-grade-bars';
import { useGradeFormat } from '@/app/hooks/use-grade-format';
import { useTranslation } from 'react-i18next';

/**
 * Read-only session overview for the kept `/session/[sessionId]` share page.
 *
 * Recreated here from `components/session-details/session-overview-panel.tsx`
 * minus its board preview. That preview (BoardRenderer + AngleSelector) only
 * ever rendered under `compact && boardDetails`, and no caller has ever passed
 * `boardDetails` — it was reachable only from the party drawer, which moves to
 * the app. Keeping it would anchor `components/board-page` from a kept route.
 */

type TFunc = (key: string, options?: Record<string, unknown>) => string;

/**
 * Build summary parts for collapsed activity pill display.
 */
export function buildSessionSummaryParts(
  stats: {
    totalFlashes: number;
    totalSends: number;
    totalAttempts: number;
    tickCount: number;
    hardestGrade?: string | null;
    formatGrade?: (g: string) => string | null;
  },
  t: TFunc,
): string[] {
  const parts: string[] = [];
  if (stats.totalFlashes > 0) parts.push(t('detail.flashesCount', { count: stats.totalFlashes }));
  // totalSends includes flashes, so subtract to avoid double-counting
  const nonFlashSends = stats.totalSends - stats.totalFlashes;
  if (nonFlashSends > 0) parts.push(t('detail.sendsCount', { count: nonFlashSends }));
  if (stats.totalAttempts > 0) parts.push(t('detail.attemptsCount', { count: stats.totalAttempts }));
  parts.push(t('detail.climbCount', { count: stats.tickCount }));
  if (stats.hardestGrade) {
    const formatted = stats.formatGrade ? stats.formatGrade(stats.hardestGrade) : stats.hardestGrade;
    parts.push(t('detail.hardestLabel', { grade: formatted ?? stats.hardestGrade }));
  }
  return parts;
}

type SessionOverviewPanelProps = {
  totalSends: number;
  totalFlashes: number;
  totalAttempts: number;
  tickCount: number;
  gradeDistribution: SessionGradeDistributionItem[];
  boardTypes: string[];
  hardestGrade?: string | null;
  durationMinutes?: number | null;
  goal?: string | null;
  /** Optional free-text end-of-session recap saved by the session creator. */
  notes?: string | null;
  afterParticipants?: React.ReactNode;
  /** When true, only render goal + notes (no chips/chart). */
  compact?: boolean;
};

export function formatDuration(minutes: number, t: TFunc): string {
  if (minutes < 60) return t('summary.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? t('summary.hoursAndMinutes', { hours, mins }) : t('summary.hours', { count: hours });
}

export default function SessionOverviewPanel({
  totalSends,
  totalFlashes,
  totalAttempts,
  tickCount,
  gradeDistribution,
  boardTypes,
  hardestGrade,
  durationMinutes,
  goal,
  notes,
  afterParticipants,
  compact = false,
}: SessionOverviewPanelProps) {
  const { t } = useTranslation('session');
  const { formatGrade, loaded: gradeFormatLoaded } = useGradeFormat();

  const gradeBars = React.useMemo(
    () => buildSessionGradeBars(gradeDistribution, formatGrade),
    [gradeDistribution, formatGrade],
  );

  return (
    <>
      {afterParticipants}

      {goal ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <FlagOutlined sx={{ fontSize: 16 }} color="action" />
          <Typography variant="body2" color="text.secondary">
            {t('overview.goal', { goal })}
          </Typography>
        </Box>
      ) : null}

      {notes ? (
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
          <NotesOutlined sx={{ fontSize: 16, mt: 0.25 }} color="action" />
          <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap', minWidth: 0 }}>
            {notes}
          </Typography>
        </Box>
      ) : null}

      {!compact && (
        <>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {totalFlashes > 0 && (
              <Chip
                icon={<FlashOnOutlined />}
                label={t('detail.flashesCount', { count: totalFlashes })}
                sx={{
                  bgcolor: 'success.main',
                  color: 'success.contrastText',
                  '& .MuiChip-icon': { color: 'inherit' },
                }}
              />
            )}
            {/* totalSends includes flashes — subtract to avoid double-counting */}
            {totalSends - totalFlashes > 0 && (
              <Chip
                icon={<CheckCircleOutlineOutlined />}
                label={t('detail.sendsCount', { count: totalSends - totalFlashes })}
                color="primary"
              />
            )}
            {totalAttempts > 0 && (
              <Chip
                icon={<ErrorOutlineOutlined />}
                label={t('detail.attemptsCount', { count: totalAttempts })}
                variant="outlined"
              />
            )}
            {durationMinutes != null && durationMinutes > 0 && (
              <Chip icon={<TimerOutlined />} label={formatDuration(durationMinutes, t)} variant="outlined" />
            )}
            <Chip label={t('detail.climbCount', { count: tickCount })} variant="outlined" />
            {hardestGrade &&
              (gradeFormatLoaded ? (
                <Chip
                  label={t('detail.hardestLabel', { grade: formatGrade(hardestGrade) ?? hardestGrade })}
                  variant="outlined"
                />
              ) : (
                <Skeleton variant="rounded" width={80} height={32} />
              ))}
          </Box>

          {boardTypes.length > 0 && (
            <Box sx={{ display: 'flex', gap: 0.5 }}>
              {boardTypes.map((boardType) => (
                <Chip
                  key={boardType}
                  label={boardType.charAt(0).toUpperCase() + boardType.slice(1)}
                  size="small"
                  variant="outlined"
                />
              ))}
            </Box>
          )}

          {gradeDistribution.length > 0 && (
            <Card>
              <CardContent>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  {t('detail.gradeDistribution')}
                </Typography>
                <CssBarChart
                  bars={gradeBars}
                  height={160}
                  mobileHeight={120}
                  gap={3}
                  ariaLabel={t('detail.sessionGradeDistribution')}
                />
                <Box sx={{ display: 'flex', gap: 1.5, justifyContent: 'center', mt: 1 }}>
                  {SESSION_GRADE_LEGEND.map((entry) => (
                    <Box key={entry.label} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <Box sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: entry.color }} />
                      <Typography variant="caption" color="text.secondary">
                        {entry.label}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </>
  );
}
