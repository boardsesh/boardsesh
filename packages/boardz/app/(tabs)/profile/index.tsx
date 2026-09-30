import { useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import {
  buildActivityHeatmap,
  buildPeriodComparison,
  deriveProfileViewModel,
  type LogbookEntry,
} from '@boardsesh/profile-stats';
import { describeRequestError } from '../../../src/api/graphql-client';
import { useAuth } from '../../../src/auth/auth-provider';
import { bandColor, gradeBandFromId, gradeLabelFromId } from '../../../src/grades/grades';
import { ActivityCalendar } from '../../../src/profile/ActivityCalendar';
import { GradeBars } from '../../../src/profile/GradeBars';
import { climbingDays, dayLabel } from '../../../src/profile/climbing-days';
import { topShare } from '../../../src/profile/percentile';
import { useClimbPercentile, useProfileData } from '../../../src/profile/use-profile-data';
import { usePreferences } from '../../../src/settings/preferences-provider';
import { Button } from '../../../src/ui/Button';
import { Card, Section } from '../../../src/ui/Card';
import { GradeBadge } from '../../../src/ui/GradeBadge';
import { IconButton } from '../../../src/ui/IconButton';
import { BookOpen, Settings } from '../../../src/ui/icons';
import { ListRow } from '../../../src/ui/ListRow';
import { PageHeader } from '../../../src/ui/PageHeader';
import { Screen } from '../../../src/ui/Screen';
import { SegmentedControl } from '../../../src/ui/SegmentedControl';
import { StatTile } from '../../../src/ui/StatTile';
import { Text } from '../../../src/ui/Text';
import { useTheme } from '../../../src/ui/theme';
import { spacing } from '../../../src/ui/tokens';

// About five months: enough to see a habit, big enough to read on a phone.
const CALENDAR_WEEKS = 22;
const RECENT_DAYS = 5;
const NO_TICKS: Record<string, LogbookEntry[]> = {};
const MONTH = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

function SettingsButton() {
  return <IconButton icon={Settings} label="Settings" size="lg" onPress={() => router.push('/profile/settings')} />;
}

export default function ProfileScreen() {
  const theme = useTheme();
  const { status, profile } = useAuth();
  const { gradeFormat } = usePreferences();
  const data = useProfileData(profile?.id);
  const percentile = useClimbPercentile(profile?.id);
  const [selectedBoard, setSelectedBoard] = useState('all');
  const monthMeta = MONTH.format(new Date());

  if (status !== 'signedIn') {
    return (
      <Screen header={<PageHeader title="Profile" meta={monthMeta} right={<SettingsButton />} />}>
        <Section title="Account">
          <Text variant="title3">Your climbing, on one page</Text>
          <Text variant="small" tone="tertiary">
            Sign in with your Boardsesh account to see your sends, hardest grades and climbing days.
          </Text>
          <Button title="Sign in" size="lg" fullWidth onPress={() => router.push('/login')} />
        </Section>
      </Screen>
    );
  }

  const ticksByBoard = data.ticksByBoard ?? NO_TICKS;
  const boardTypes = Object.keys(ticksByBoard).filter((boardType) => (ticksByBoard[boardType] ?? []).length > 0);
  const scopedTicks =
    selectedBoard === 'all' || !boardTypes.includes(selectedBoard)
      ? ticksByBoard
      : { [selectedBoard]: ticksByBoard[selectedBoard] ?? [] };
  const entries = Object.values(scopedTicks).flat();

  const view = deriveProfileViewModel({
    allBoardsTicks: scopedTicks,
    selectedBoard: 'all',
    timeframe: 'all',
    fromDate: '',
    toDate: '',
    gradeFormat,
    profileStats: selectedBoard === 'all' ? data.stats : null,
    comparisonMode: 'trailing',
  });
  const pastMonth = buildPeriodComparison(scopedTicks, 'lastMonth', 'trailing');
  const heatmap = buildActivityHeatmap(entries, CALENDAR_WEEKS);
  const days = climbingDays(entries).slice(0, RECENT_DAYS);
  const today = new Date();
  // Lifetime distinct climbs come from Boardsesh's stats; per board, count the loaded ticks.
  const climbsSent =
    selectedBoard === 'all'
      ? view.statisticsSummary.totalAscents
      : new Set(entries.filter((entry) => entry.status !== 'attempt').map((entry) => entry.climbUuid)).size;
  const monthDelta = pastMonth?.sendsDelta ?? 0;
  // The percentile ranks every board together, so it only fits the all-boards view.
  const rank = selectedBoard === 'all' && percentile.data ? topShare(percentile.data.percentile) : null;
  const name = profile?.displayName || profile?.email || 'You';

  return (
    <Screen
      header={<PageHeader title={name} meta={monthMeta} right={<SettingsButton />} />}
      refreshControl={<RefreshControl refreshing={data.isRefetching} onRefresh={data.refetch} />}
    >
      {boardTypes.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <SegmentedControl
            size="md"
            value={selectedBoard}
            onChange={setSelectedBoard}
            options={[
              { value: 'all', label: 'All boards' },
              ...boardTypes.map((boardType) => ({ value: boardType, label: formatBoardDisplayName(boardType) })),
            ]}
          />
        </ScrollView>
      ) : null}

      {data.isLoading ? (
        <ActivityIndicator style={styles.loading} />
      ) : data.error ? (
        <Section>
          <Text tone="tertiary">{describeRequestError(data.error)}</Text>
          <Button title="Try again" variant="secondary" onPress={data.refetch} />
        </Section>
      ) : (
        <>
          <View style={styles.tiles}>
            <StatTile
              label="Sends · 30 days"
              value={String(pastMonth?.current.sends ?? 0)}
              delta={pastMonth ? `${monthDelta >= 0 ? '+' : ''}${monthDelta} vs 30 before` : undefined}
            />
            <StatTile label="Climbs sent" value={climbsSent.toLocaleString()} unit={rank ?? 'lifetime'} />
          </View>
          <View style={styles.tiles}>
            <StatTile
              label="Top grade"
              value={view.hardestSend?.label ?? '–'}
              valueColor={bandColor(theme.grades, gradeBandFromId(view.hardestSend?.difficulty))}
            />
            <StatTile
              label="Top flash"
              value={view.hardestFlash?.label ?? '–'}
              valueColor={bandColor(theme.grades, gradeBandFromId(view.hardestFlash?.difficulty))}
            />
          </View>

          <Section title="Activity">
            {heatmap ? (
              <ActivityCalendar heatmap={heatmap} />
            ) : (
              <Text tone="tertiary">No climbing logged in the last {CALENDAR_WEEKS} weeks.</Text>
            )}
          </Section>

          <Section title="Grade pyramid">
            {view.aggregatedStackedBars ? (
              <GradeBars bars={view.aggregatedStackedBars} />
            ) : (
              <Text tone="tertiary">Log a send to build your pyramid.</Text>
            )}
          </Section>

          <View style={styles.group}>
            <Text variant="label" accessibilityRole="header" style={styles.groupLabel}>
              Recent days
            </Text>
            <Card flush>
              {days.map((day) => (
                <ListRow
                  key={day.date}
                  title={dayLabel(day.date, today)}
                  meta={`${day.sends} sent · ${day.tries} ${day.tries === 1 ? 'try' : 'tries'}`}
                  detail={
                    day.hardestSendDifficulty !== null ? (
                      <GradeBadge
                        label={gradeLabelFromId(day.hardestSendDifficulty, gradeFormat)}
                        band={gradeBandFromId(day.hardestSendDifficulty)}
                        variant="solid"
                        size="sm"
                      />
                    ) : undefined
                  }
                  separator
                />
              ))}
              <ListRow
                title="All ascents"
                icon={BookOpen}
                accessory="chevron"
                onPress={() => router.push('/profile/logbook')}
              />
            </Card>
          </View>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: spacing.xl },
  tiles: { flexDirection: 'row', gap: 10 },
  group: { gap: spacing.sm },
  groupLabel: { paddingHorizontal: spacing.xxs },
});
