import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { FlashList, type ListRenderItem } from '@shopify/flash-list';
import { Stack, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  formatGymReportingObservationWindow,
  formatGymReportingTime,
  GYM_REPORTING_PERIODS,
  gymBusyTimesScope,
  gymReportingHasActivity,
  gymReportingHasExactObservations,
  gymReportingQueryPrefix,
  isGymReportingAccessError,
  SET_GYM_REPORTING_BOARD_ALIAS,
  SET_GYM_REPORTING_TIME_ZONE,
  type GymTrendMetric,
  type GymTrendSelection,
} from '@boardsesh/graphql';
import type { GymStats, GymStatsPeriod } from '@boardsesh/shared-schema';
import { useAuth } from '../../src/providers/auth-provider';
import { useTheme } from '../../src/providers/theme-provider';
import { useStoredUserId } from '../../src/hooks/use-current-user-id';
import { useStackScreenOptions } from '../../src/hooks/use-stack-screen-options';
import {
  requestForGymViewer,
  useGymReporting,
  useGymReportingForeground,
} from '../../src/lib/graphql/hooks/use-gym-reporting';
import { getHttpClient } from '../../src/lib/graphql/client';
import { ActivityIndicator } from '../../src/components/ActivityIndicator';
import { AppMenu } from '../../src/components/AppMenu';
import { Button } from '../../src/components/Button';
import { SegmentedControl } from '../../src/components/SegmentedControl';
import { Text } from '../../src/components/Text';
import { GymReportingSettings } from '../../src/components/gym-directory/GymReportingSettings';
import { GymReachReport } from '../../src/components/gym-directory/GymReachReport';
import { GymGradeComparisonPanel } from '../../src/components/gym-directory/GymGradeComparisonPanel';
import {
  buildGymAngleUsageRows,
  GymAngleUsageListItem,
  type GymAngleUsageListRow,
} from '../../src/components/gym-directory/GymAngleUsage';
import { GymBusyTimesCard } from '../../src/components/gym-directory/GymBusyTimesCard';
import { spacing } from '../../src/theme/tokens';

function ReportingResults({ stats, trend }: { stats: GymStats; trend: GymTrendSelection }) {
  const { t, i18n } = useTranslation('boards');
  const { systemColors } = useTheme();
  const locale = i18n.language || 'en-US';
  const number = new Intl.NumberFormat(locale);
  const time = (at: string) => formatGymReportingTime(at, stats.timeZone, locale);
  const observations = formatGymReportingObservationWindow(stats, locale);
  const unknownTimes = stats.coverage.boundaryUncertainCount + stats.coverage.unknownTimeCount;

  return (
    <View style={styles.section}>
      <View style={styles.details}>
        <Text variant="subheadline">
          {t('gymReporting.period', { start: time(stats.current.startAt), end: time(stats.current.endAt) })}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {t('gymReporting.previousPeriod', { start: time(stats.previous.startAt), end: time(stats.previous.endAt) })}
        </Text>
        <Text variant="subheadline" color={systemColors.secondaryLabel}>
          {stats.timeZoneConfigured
            ? t('gymReporting.zoneValue', { zone: stats.timeZone })
            : t('gymReporting.utcFallback')}
        </Text>
        {stats.coverage.isPartial && (
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('gymReporting.partial')}
          </Text>
        )}
        {stats.coverage.includesCurrentBoardHistory && (
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('gymReporting.currentBoardHistory')}
          </Text>
        )}
        {unknownTimes > 0 && (
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('gymReporting.unknownTiming', { countText: number.format(unknownTimes) })}
          </Text>
        )}
        {stats.coverage.dateOnlyCount > 0 && (
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('gymReporting.dateOnly', { countText: number.format(stats.coverage.dateOnlyCount) })}
          </Text>
        )}
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {t('gymReporting.freshness', { date: time(stats.asOf) })}
        </Text>
        <View style={styles.details}>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {t('gymReporting.observationWindow', { start: observations.start, end: observations.end })}
          </Text>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {observations.firstDisplay
              ? t('gymReporting.firstDisplay', { date: observations.firstDisplay })
              : t('gymReporting.noTimedDisplay')}
          </Text>
          <Text variant="footnote" color={systemColors.secondaryLabel}>
            {observations.firstTick
              ? t('gymReporting.firstTick', { date: observations.firstTick })
              : t('gymReporting.noTimedTick')}
          </Text>
        </View>
      </View>
      {stats.reachOverview ? (
        <GymReachReport stats={stats} overview={stats.reachOverview} selection={trend} />
      ) : gymReportingHasActivity(stats) ? (
        <View style={styles.details}>
          <Text variant="headline">
            {t('gymReporting.climbers', { countText: number.format(stats.current.uniqueClimbers) })}
          </Text>
          <Text variant="headline">
            {t('gymReporting.sends', { countText: number.format(stats.current.ascentCount) })}
          </Text>
        </View>
      ) : (
        <Text variant="subheadline">
          {gymReportingHasExactObservations(stats) ? t('gymReporting.empty') : t('gymReporting.noHistory')}
        </Text>
      )}
    </View>
  );
}

type ReportingScope = {
  viewerId: string;
  gymUuid: string;
};

type ReportingFilters = {
  boardUuid: string | null;
  setBoardUuid: (boardUuid: string | null) => void;
  period: GymStatsPeriod;
  setPeriod: (period: GymStatsPeriod) => void;
  trend: GymTrendSelection;
};

const angleUsageRowKey = (row: GymAngleUsageListRow) => row.key;
const angleUsageRowKind = (row: GymAngleUsageListRow) => row.kind;

function GymAnalyticsReport({
  viewerId,
  gymUuid,
  boardUuid,
  setBoardUuid,
  period,
  setPeriod,
  trend,
}: ReportingScope & ReportingFilters) {
  const { t, i18n } = useTranslation('boards');
  const queryClient = useQueryClient();
  const query = useGymReporting(viewerId, gymUuid, boardUuid, period);
  const stats = query.state === 'ready' || query.state === 'stale' ? query.data : undefined;
  const locale = i18n.language || 'en-US';
  const angleUsageRows = useMemo(() => (stats ? buildGymAngleUsageRows(stats, locale) : []), [stats, locale]);
  const [expandedAngle, setExpandedAngle] = useState<string | null>(null);
  const toggleAngle = useCallback((key: string) => {
    setExpandedAngle((expanded) => (expanded === key ? null : key));
  }, []);
  const renderAngleUsageRow = useCallback<ListRenderItem<GymAngleUsageListRow>>(
    ({ item }) => <GymAngleUsageListItem row={item} expanded={expandedAngle === item.key} onToggle={toggleAngle} />,
    [expandedAngle, toggleAngle],
  );
  const selectedBoard = stats?.boards.find((board) => board.uuid === stats.boardUuid);
  const scopeOptions = [{ uuid: null, name: t('gymReporting.allBoards') }, ...(stats?.boards ?? [])];
  const number = new Intl.NumberFormat(i18n.language || 'en-US');
  const refresh = () => queryClient.invalidateQueries({ queryKey: gymReportingQueryPrefix(viewerId, gymUuid) });

  async function saveZone(timeZone: string | null) {
    try {
      await requestForGymViewer(viewerId, () =>
        getHttpClient().request(SET_GYM_REPORTING_TIME_ZONE, {
          input: { gymUuid: stats?.gymUuid ?? gymUuid, timeZone },
        }),
      );
    } catch (error) {
      if (isGymReportingAccessError(error)) void query.retireReport();
      throw error;
    }
    await refresh();
  }

  async function saveAlias(sourceUuid: string, rootBoardUuid: string | null) {
    try {
      await requestForGymViewer(viewerId, () =>
        getHttpClient().request(SET_GYM_REPORTING_BOARD_ALIAS, {
          input: { gymUuid: stats?.gymUuid ?? gymUuid, boardUuid: sourceUuid, rootBoardUuid },
        }),
      );
    } catch (error) {
      if (isGymReportingAccessError(error)) void query.retireReport();
      throw error;
    }
    setBoardUuid(null);
    await refresh();
  }

  const reportHeader = (
    <View style={styles.section}>
      {stats && (
        <Text accessibilityRole="header" variant="title2">
          {stats.gymName}
        </Text>
      )}
      <SegmentedControl
        options={GYM_REPORTING_PERIODS.map(({ key, days }) => ({
          key,
          label: t('gymReporting.rangeDays', { days: number.format(days) }),
        }))}
        selectedKey={period}
        onSelect={setPeriod}
        accessibilityLabel={t('gymReporting.range')}
      />
      {stats && (
        <View style={styles.details}>
          <Text variant="subheadline">{t('gymReporting.boardScope')}</Text>
          {query.state === 'ready' ? (
            <AppMenu
              label={selectedBoard?.name ?? t('gymReporting.allBoards')}
              accessibilityLabel={t('gymReporting.boardScope')}
              actions={scopeOptions.map((board) => ({ label: board.name, selected: board.uuid === stats.boardUuid }))}
              onSelectIndex={(index) => {
                const chosen = scopeOptions[index];
                if (chosen) setBoardUuid(chosen.uuid);
              }}
            />
          ) : (
            <Text>{selectedBoard?.name ?? t('gymReporting.allBoards')}</Text>
          )}
        </View>
      )}
      {query.state === 'loading' && <ActivityIndicator size="large" />}
      {query.state === 'offline' && <Text accessibilityRole="alert">{t('gymReporting.offline')}</Text>}
      {query.state === 'denied' && (
        <Text accessibilityRole="alert">{boardUuid ? t('gymReporting.boardDenied') : t('gymReporting.denied')}</Text>
      )}
      {query.state === 'error' && <Text accessibilityRole="alert">{t('gymReporting.loadError')}</Text>}
      {(query.state === 'offline' || query.state === 'denied' || query.state === 'error') && (
        <View style={styles.actions}>
          <Button title={t('gymReporting.retry')} variant="outlined" onPress={() => void query.refetch()} />
          {boardUuid && (
            <Button title={t('gymReporting.allBoards')} variant="outlined" onPress={() => setBoardUuid(null)} />
          )}
        </View>
      )}
      {stats && (
        <>
          {query.state === 'ready' && !stats.timeZoneConfigured && (
            <GymReportingSettings stats={stats} saveZone={saveZone} saveAlias={saveAlias} />
          )}
          {query.state === 'stale' && (
            <Text accessibilityRole="alert">
              {t('gymReporting.stale', {
                date: formatGymReportingTime(stats.asOf, stats.timeZone, i18n.language || 'en-US'),
              })}
            </Text>
          )}
          <ReportingResults stats={stats} trend={trend} />
          {query.state === 'ready' && (
            <View style={styles.actions}>
              <Button title={t('gymReporting.refresh')} variant="outlined" onPress={() => void query.refetch()} />
            </View>
          )}
        </>
      )}
      <GymBusyTimesCard
        key={JSON.stringify([gymUuid, boardUuid])}
        report={stats?.busyTimes}
        timeZone={stats?.timeZone}
        scope={gymBusyTimesScope(stats)}
      />
      {angleUsageRows.length > 0 && (
        <Text accessibilityRole="header" variant="title2">
          {t('gymReporting.angleUsage.title')}
        </Text>
      )}
    </View>
  );
  const reportFooter =
    stats && query.state === 'ready' ? (
      <View style={styles.settings}>
        <GymGradeComparisonPanel
          key={`${boardUuid ?? ''}:${period}`}
          viewerId={viewerId}
          gymUuid={stats.gymUuid}
          overviewGymUuid={gymUuid}
          boardUuid={boardUuid}
          period={period}
        />
        {stats.timeZoneConfigured && <GymReportingSettings stats={stats} saveZone={saveZone} saveAlias={saveAlias} />}
      </View>
    ) : null;

  return (
    <FlashList
      data={angleUsageRows}
      renderItem={renderAngleUsageRow}
      keyExtractor={angleUsageRowKey}
      getItemType={angleUsageRowKind}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      ListHeaderComponent={reportHeader}
      ListFooterComponent={reportFooter}
    />
  );
}

function GymAnalyticsViewer({ viewerId, gymUuid }: ReportingScope) {
  const [period, setPeriod] = useState<GymStatsPeriod>('week');
  const [boardUuid, setBoardUuid] = useState<string | null>(null);
  const [week, setWeek] = useState<string | null>(null);
  const [metric, setMetric] = useState<GymTrendMetric>('climbers');
  const chooseBoard = (next: string | null) => {
    if (next !== boardUuid) setWeek(null);
    setBoardUuid(next);
  };
  const focused = useIsFocused();
  const foreground = useGymReportingForeground();
  if (!focused || !foreground) return null;
  return (
    <GymAnalyticsReport
      viewerId={viewerId}
      gymUuid={gymUuid}
      boardUuid={boardUuid}
      setBoardUuid={chooseBoard}
      trend={{ metric, setMetric, week, setWeek }}
      period={period}
      setPeriod={setPeriod}
    />
  );
}

export default function GymAnalyticsScreen() {
  const { gymUuid } = useLocalSearchParams<{ gymUuid?: string }>();
  const { t } = useTranslation('boards');
  const { isAuthenticated, isLoading } = useAuth();
  const { userId, isLoading: isLoadingViewer } = useStoredUserId(isAuthenticated);
  const { systemColors } = useTheme();
  const options = useStackScreenOptions();

  return (
    <View style={[styles.screen, { backgroundColor: systemColors.background }]}>
      <Stack.Screen options={{ ...options, title: t('gymReporting.title'), headerShown: true }} />
      {isLoading || isLoadingViewer ? (
        <View style={styles.content}>
          <ActivityIndicator size="large" />
        </View>
      ) : isAuthenticated && userId && typeof gymUuid === 'string' && gymUuid ? (
        <GymAnalyticsViewer key={`${userId}:${gymUuid}`} viewerId={userId} gymUuid={gymUuid} />
      ) : (
        <View style={styles.content}>
          <Text accessibilityRole="alert">{t('gymReporting.denied')}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: spacing[4] },
  settings: { paddingTop: spacing[4], gap: spacing[4] },
  section: { gap: spacing[4] },
  details: { gap: spacing[1] },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
});
