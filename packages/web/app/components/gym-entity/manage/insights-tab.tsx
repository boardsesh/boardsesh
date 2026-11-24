'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import { focusManager, onlineManager, useQuery, useQueryClient } from '@tanstack/react-query';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import MenuItem from '@mui/material/MenuItem';
import Skeleton from '@mui/material/Skeleton';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import {
  formatGymReportingObservationWindow,
  formatGymReportingTime,
  GET_GYM_STATS,
  GYM_REPORTING_PERIODS,
  gymBusyTimesScope,
  gymReportingCountDelta,
  gymReportingHasActivity,
  gymReportingHasExactObservations,
  gymReportingQueryKey,
  gymReportingQueryOptions,
  gymReportingQueryPrefix,
  gymReportingReadState,
  isGymReportingAccessError,
  retireGymReportingReceipt,
  scheduleGymReportingReceiptExpiry,
  SET_GYM_REPORTING_BOARD_ALIAS,
  SET_GYM_REPORTING_TIME_ZONE,
  type GymTrendMetric,
  type GymTrendSelection,
  type GetGymStatsQueryResponse,
  type GetGymStatsQueryVariables,
} from '@boardsesh/graphql';
import type { GymStats, GymStatsPeriod } from '@boardsesh/shared-schema';
import { boardTypeLabel } from '@boardsesh/board-constants';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import SelectedCheck from '@/app/components/ui/selected-check';
import type { GymManageTabProps } from './tab-props';
import { GymReportingSettings } from './gym-reporting-settings';
import { GymReachReport } from './gym-reach-overview';
import { GymGradeComparisonPanel } from './gym-grade-comparison';
import { GymAngleUsage } from './gym-angle-usage';
import { GymBusyTimesCard } from './gym-busy-times';

let reconnectAt = 0;
function subscribeOnline(onChange: () => void) {
  return onlineManager.subscribe((online) => {
    if (online) reconnectAt = Date.now();
    onChange();
  });
}
function getConnectivity() {
  return onlineManager.isOnline() ? reconnectAt : -1;
}
function subscribeFocus(onChange: () => void) {
  return focusManager.subscribe(onChange);
}

export const computeWowDelta = gymReportingCountDelta;

function ReportingResults({ stats, trend }: { stats: GymStats; trend: GymTrendSelection }) {
  const { t, i18n } = useTranslation('boards');
  const locale = i18n.language || 'en-US';
  const number = new Intl.NumberFormat(locale);
  const observations = formatGymReportingObservationWindow(stats, locale);
  const time = (at: string) => formatGymReportingTime(at, stats.timeZone, locale);
  const unknownTimes = stats.coverage.boundaryUncertainCount + stats.coverage.unknownTimeCount;
  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Box sx={{ display: 'grid', gap: 0.5 }}>
        <Typography variant="body2">
          {t('gymReporting.period', { start: time(stats.current.startAt), end: time(stats.current.endAt) })}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t('gymReporting.previousPeriod', { start: time(stats.previous.startAt), end: time(stats.previous.endAt) })}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {stats.timeZoneConfigured
            ? t('gymReporting.zoneValue', { zone: stats.timeZone })
            : t('gymReporting.utcFallback')}
        </Typography>
        {stats.coverage.isPartial && (
          <Typography variant="body2" color="text.secondary">
            {t('gymReporting.partial')}
          </Typography>
        )}
        {stats.coverage.includesCurrentBoardHistory && (
          <Typography variant="body2" color="text.secondary">
            {t('gymReporting.currentBoardHistory')}
          </Typography>
        )}
        {unknownTimes > 0 && (
          <Typography variant="body2" color="text.secondary">
            {t('gymReporting.unknownTiming', { countText: number.format(unknownTimes) })}
          </Typography>
        )}
        {stats.coverage.dateOnlyCount > 0 && (
          <Typography variant="body2" color="text.secondary">
            {t('gymReporting.dateOnly', { countText: number.format(stats.coverage.dateOnlyCount) })}
          </Typography>
        )}
        <Typography variant="body2" color="text.secondary">
          {t('gymReporting.freshness', { date: time(stats.asOf) })}
        </Typography>
        <Box>
          <Typography variant="body2" color="text.secondary">
            {t('gymReporting.observationWindow', { start: observations.start, end: observations.end })}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {observations.firstDisplay
              ? t('gymReporting.firstDisplay', { date: observations.firstDisplay })
              : t('gymReporting.noTimedDisplay')}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {observations.firstTick
              ? t('gymReporting.firstTick', { date: observations.firstTick })
              : t('gymReporting.noTimedTick')}
          </Typography>
        </Box>
      </Box>
      {stats.reachOverview && <GymReachReport stats={stats} overview={stats.reachOverview} selection={trend} />}
      {gymReportingHasActivity(stats) ? (
        <>
          {!stats.reachOverview && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              <Chip label={t('gymReporting.climbers', { countText: number.format(stats.current.uniqueClimbers) })} />
              <Chip label={t('gymReporting.sends', { countText: number.format(stats.current.ascentCount) })} />
            </Box>
          )}
          {stats.topClimbs.length > 0 && (
            <Box>
              <Typography variant="subtitle2">{t('gymReporting.topClimbs')}</Typography>
              <List dense disablePadding data-testid="insights-top-climbs">
                {stats.topClimbs.map((climb) => (
                  <ListItem
                    key={`${climb.boardType}:${climb.climbUuid}:${climb.angle}`}
                    disableGutters
                    sx={{ gap: 1, flexWrap: 'wrap' }}
                  >
                    <Typography variant="body2">{climb.name ?? boardTypeLabel(climb.boardType)}</Typography>
                    {climb.gradeName && <Chip label={climb.gradeName} size="small" />}
                    <Typography variant="body2" color="text.secondary">
                      {t('gymReporting.sends', { countText: number.format(climb.ascentCount) })}
                    </Typography>
                  </ListItem>
                ))}
              </List>
            </Box>
          )}
        </>
      ) : (
        <Typography variant="body2" role="status">
          {gymReportingHasExactObservations(stats) ? t('gymReporting.empty') : t('gymReporting.noHistory')}
        </Typography>
      )}
      <GymAngleUsage key={`${stats.boardUuid ?? 'all'}:${stats.periodDays}:${stats.asOf}`} stats={stats} />
    </Box>
  );
}

type ReportingViewer = { viewer: string; gymUuid: string; token: string };

type ReportingFilters = {
  period: GymStatsPeriod;
  setPeriod: (period: GymStatsPeriod) => void;
  boardUuid: string | null;
  setBoardUuid: (boardUuid: string | null) => void;
  trend: GymTrendSelection;
};

function InsightsReport({
  viewer,
  gymUuid,
  token,
  period,
  setPeriod,
  boardUuid,
  setBoardUuid,
  trend,
}: ReportingViewer & ReportingFilters) {
  const { t, i18n } = useTranslation('boards');
  const reconnect = useSyncExternalStore(subscribeOnline, getConnectivity, () => 0);
  const queryClient = useQueryClient();
  const query = useQuery({
    ...gymReportingQueryOptions,
    queryKey: gymReportingQueryKey(viewer, gymUuid, boardUuid, period),
    queryFn: async ({ signal }) => {
      const response = await createGraphQLHttpClient(token).request<
        GetGymStatsQueryResponse,
        GetGymStatsQueryVariables
      >({
        document: GET_GYM_STATS,
        signal,
        variables: { input: { gymUuid, boardUuid, period } },
      });
      return response.gymStats;
    },
  });
  const state = gymReportingReadState({ ...query, offline: reconnect < 0, verifiedAfter: Math.max(0, reconnect) });
  const stats = state === 'ready' || state === 'stale' ? query.data : undefined;

  const { dataUpdatedAt } = query;
  useEffect(
    () =>
      scheduleGymReportingReceiptExpiry(
        queryClient,
        gymReportingQueryKey(viewer, gymUuid, boardUuid, period),
        dataUpdatedAt,
      ),
    [queryClient, viewer, gymUuid, boardUuid, period, dataUpdatedAt],
  );

  useEffect(() => {
    if (state !== 'denied') return;
    const queryKey = gymReportingQueryKey(viewer, gymUuid, boardUuid, period);
    queryClient.getQueryCache().find({ queryKey, exact: true })?.setState({ data: undefined, dataUpdatedAt: 0 });
    queryClient.removeQueries({ queryKey: gymReportingQueryPrefix(viewer, gymUuid), type: 'inactive' });
  }, [state, queryClient, viewer, gymUuid, boardUuid, period]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: gymReportingQueryPrefix(viewer, gymUuid) });
  const retireReport = () =>
    retireGymReportingReceipt(queryClient, {
      queryKey: gymReportingQueryPrefix(viewer, gymUuid),
    });

  async function saveZone(timeZone: string | null) {
    try {
      await createGraphQLHttpClient(token).request(SET_GYM_REPORTING_TIME_ZONE, {
        input: { gymUuid: stats?.gymUuid ?? gymUuid, timeZone },
      });
    } catch (error) {
      if (isGymReportingAccessError(error)) void retireReport();
      throw error;
    }
    await refresh();
  }

  async function saveAlias(sourceUuid: string, rootBoardUuid: string | null) {
    try {
      await createGraphQLHttpClient(token).request(SET_GYM_REPORTING_BOARD_ALIAS, {
        input: { gymUuid: stats?.gymUuid ?? gymUuid, boardUuid: sourceUuid, rootBoardUuid },
      });
    } catch (error) {
      if (isGymReportingAccessError(error)) void retireReport();
      throw error;
    }
    setBoardUuid(null);
    await refresh();
  }

  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      <Typography component="h2" variant="h6">
        {stats?.gymName ?? t('gymReporting.title')}
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'start' }}>
        <ToggleButtonGroup
          value={period}
          exclusive
          size="small"
          aria-label={t('gymReporting.range')}
          onChange={(_event, next: GymStatsPeriod | null) => {
            if (next) setPeriod(next);
          }}
        >
          {GYM_REPORTING_PERIODS.map(({ key, days }) => (
            <ToggleButton key={key} value={key} sx={{ gap: 0.5 }}>
              {period === key && <SelectedCheck />}
              {t('gymReporting.rangeDays', { days: new Intl.NumberFormat(i18n.language || 'en-US').format(days) })}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        {stats && (
          <TextField
            select
            size="small"
            label={t('gymReporting.boardScope')}
            value={stats.boardUuid ?? ''}
            sx={{ minWidth: 180 }}
            disabled={state === 'stale'}
            onChange={(event) => setBoardUuid(event.target.value || null)}
          >
            <MenuItem value="">{t('gymReporting.allBoards')}</MenuItem>
            {stats.boards.map((board) => (
              <MenuItem value={board.uuid} key={board.uuid}>
                {board.name}
              </MenuItem>
            ))}
          </TextField>
        )}
        {state === 'ready' && <Button onClick={() => void query.refetch()}>{t('gymReporting.refresh')}</Button>}
      </Box>
      {state === 'loading' && <Skeleton height={120} variant="rounded" data-testid="insights-loading" />}
      {state === 'offline' && <Alert severity="info">{t('gymReporting.offline')}</Alert>}
      {state === 'denied' && (
        <Alert severity="warning">{boardUuid ? t('gymReporting.boardDenied') : t('gymReporting.denied')}</Alert>
      )}
      {state === 'error' && <Alert severity="error">{t('gymReporting.loadError')}</Alert>}
      {(state === 'error' || state === 'denied' || state === 'offline') && (
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button onClick={() => void query.refetch()}>{t('gymReporting.retry')}</Button>
          {boardUuid && <Button onClick={() => setBoardUuid(null)}>{t('gymReporting.allBoards')}</Button>}
        </Box>
      )}
      {stats && (
        <>
          {state === 'stale' && (
            <Alert severity="info">
              {t('gymReporting.stale', {
                date: formatGymReportingTime(stats.asOf, stats.timeZone, i18n.language || 'en-US'),
              })}
            </Alert>
          )}
          <ReportingResults stats={stats} trend={trend} />
        </>
      )}
      <GymBusyTimesCard
        key={JSON.stringify([gymUuid, boardUuid])}
        report={stats?.busyTimes}
        timeZone={stats?.timeZone}
        scope={gymBusyTimesScope(stats)}
      />
      {stats && state === 'ready' && (
        <>
          <GymGradeComparisonPanel
            key={`${boardUuid ?? ''}:${period}`}
            viewerId={viewer}
            token={token}
            gymUuid={stats.gymUuid}
            overviewGymUuid={gymUuid}
            boardUuid={boardUuid}
            period={period}
          />
          <GymReportingSettings stats={stats} saveZone={saveZone} saveAlias={saveAlias} />
        </>
      )}
    </Box>
  );
}

function InsightsViewer({ viewer, gymUuid, token }: ReportingViewer) {
  const [period, setPeriod] = useState<GymStatsPeriod>('week');
  const [boardUuid, setBoardUuid] = useState<string | null>(null);
  const [week, setWeek] = useState<string | null>(null);
  const [metric, setMetric] = useState<GymTrendMetric>('climbers');
  const chooseBoard = (next: string | null) => {
    if (next !== boardUuid) setWeek(null);
    setBoardUuid(next);
  };
  const focused = useSyncExternalStore(
    subscribeFocus,
    () => focusManager.isFocused(),
    () => true,
  );
  if (!focused) return null;
  return (
    <InsightsReport
      viewer={viewer}
      gymUuid={gymUuid}
      token={token}
      period={period}
      setPeriod={setPeriod}
      boardUuid={boardUuid}
      setBoardUuid={chooseBoard}
      trend={{ metric, setMetric, week, setWeek }}
    />
  );
}

export default function InsightsTab({ gym }: GymManageTabProps) {
  const { t } = useTranslation('boards');
  const { data: session, status } = useSession();
  const { token, isLoading } = useWsAuthToken();
  if (status === 'loading' || isLoading) {
    return <Skeleton height={120} variant="rounded" data-testid="insights-loading" />;
  }
  const viewerId = session?.user?.id;
  if (status !== 'authenticated' || !viewerId || !token) {
    return <Alert severity="warning">{t('gymReporting.denied')}</Alert>;
  }
  const viewer = JSON.stringify([viewerId, session?.authSessionId ?? null]);
  return <InsightsViewer key={`${viewer}:${gym.uuid}`} gymUuid={gym.uuid} viewer={viewer} token={token} />;
}
