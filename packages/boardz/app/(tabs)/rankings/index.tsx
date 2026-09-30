import { memo, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { describeRequestError } from '../../../src/api/graphql-client';
import { useAuth } from '../../../src/auth/auth-provider';
import { useBoard } from '../../../src/board/board-provider';
import { useAccountBoards } from '../../../src/board/use-account-boards';
import { bandColor, gradeBand, gradeLabel, type GradeDisplayFormat } from '../../../src/grades/grades';
import { useLeaderboard, type RankingPeriod } from '../../../src/rankings/use-leaderboard';
import { usePublicWalls } from '../../../src/rankings/use-public-walls';
import { usePreferences } from '../../../src/settings/preferences-provider';
import { Avatar } from '../../../src/ui/Avatar';
import { Badge } from '../../../src/ui/Badge';
import { Button } from '../../../src/ui/Button';
import { Section } from '../../../src/ui/Card';
import { Chip } from '../../../src/ui/Chip';
import { PageHeader } from '../../../src/ui/PageHeader';
import { SegmentedControl } from '../../../src/ui/SegmentedControl';
import { Text } from '../../../src/ui/Text';
import { useTheme } from '../../../src/ui/theme';
import { GUTTER, radius, spacing } from '../../../src/ui/tokens';

type LeaderboardEntry = NonNullable<ReturnType<typeof useLeaderboard>['data']>['pages'][number]['entries'][number];

const PERIODS: readonly { value: RankingPeriod; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
  { value: 'all', label: 'All time' },
];

const keyExtractor = (entry: LeaderboardEntry) => entry.userId;

const RankRow = memo(function RankRow({
  entry,
  isYou,
  gradeFormat,
}: {
  entry: LeaderboardEntry;
  isYou: boolean;
  gradeFormat: GradeDisplayFormat;
}) {
  const theme = useTheme();
  const name = entry.userDisplayName || 'Climber';
  const top = entry.hardestGradeName ? gradeLabel(entry.hardestGradeName, gradeFormat) : null;
  return (
    <View
      accessible
      accessibilityLabel={`Rank ${entry.rank}, ${isYou ? 'you' : name}, ${entry.totalSends} sends${top ? `, top grade ${top}` : ''}`}
      style={[
        styles.row,
        { borderBottomColor: theme.border1 },
        isYou && [styles.youRow, { backgroundColor: theme.bgSurface3 }],
      ]}
    >
      <Text variant="mono" color={entry.rank <= 3 ? theme.fg1 : theme.fg3} style={styles.rank}>
        {String(entry.rank).padStart(2, '0')}
      </Text>
      <Avatar name={name} imageUrl={entry.userAvatarUrl ?? null} size={34} />
      <View style={styles.copy}>
        <View style={styles.nameRow}>
          <Text variant="bodyStrong" numberOfLines={1} style={styles.name}>
            {name}
          </Text>
          {isYou ? (
            <Badge mono outline size="xs">
              You
            </Badge>
          ) : null}
        </View>
        <Text variant="mono" tone="tertiary" numberOfLines={1}>
          {entry.totalFlashes} {entry.totalFlashes === 1 ? 'flash' : 'flashes'}
          {top ? ' · top ' : ''}
          {top ? (
            <Text variant="mono" color={bandColor(theme.grades, gradeBand(entry.hardestGradeName))}>
              {top}
            </Text>
          ) : null}
        </Text>
      </View>
      <Text variant="value" monospacedDigits>
        {entry.totalSends.toLocaleString()}
      </Text>
    </View>
  );
});

type Wall = { uuid: string; label: string; count?: string; spoken: string };

export default function RankingsScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { board } = useBoard();
  const { status, profile } = useAuth();
  const { gradeFormat } = usePreferences();
  const accountBoards = useAccountBoards();
  const publicWalls = usePublicWalls(board);
  // Most walls see few sends in a month, so the whole history is the useful default.
  const [period, setPeriod] = useState<RankingPeriod>('all');
  const [chosenWall, setChosenWall] = useState<string | null>(null);

  // Rankings belong to a wall on Boardsesh. Yours come first: this board when it
  // is one, then your account's walls with the same layout. Then public walls
  // (gyms', and climbers' shared ones) with the same setup.
  const ownWalls: Wall[] = [];
  if (board?.boardUuid) ownWalls.push({ uuid: board.boardUuid, label: 'Your wall', spoken: 'Your wall' });
  for (const wall of accountBoards.data ?? []) {
    if (!board || !wall.boardUuid || wall.boardName !== board.boardName || wall.layoutId !== board.layoutId) continue;
    if (ownWalls.some((own) => own.uuid === wall.boardUuid)) continue;
    ownWalls.push({ uuid: wall.boardUuid, label: wall.name, spoken: wall.name });
  }
  const walls: Wall[] = [
    ...ownWalls,
    ...(publicWalls.data ?? [])
      .filter((wall) => !ownWalls.some((own) => own.uuid === wall.uuid))
      .map((wall) => {
        const label = wall.locationName ? `${wall.name} · ${wall.locationName}` : wall.name;
        const climbers = `${wall.uniqueClimbers} ${wall.uniqueClimbers === 1 ? 'climber' : 'climbers'}`;
        return { uuid: wall.uuid, label, count: String(wall.uniqueClimbers), spoken: `${label}, ${climbers}` };
      }),
  ];
  const wallUuid = walls.find((wall) => wall.uuid === chosenWall)?.uuid ?? walls[0]?.uuid;
  const leaderboard = useLeaderboard(wallUuid, period);
  const entries = leaderboard.data?.pages.flatMap((page) => page.entries) ?? [];
  const periodLabel = leaderboard.data?.pages[0]?.periodLabel;

  const header = (
    <View>
      <PageHeader title="Rankings" meta={board ? board.name : 'No board yet'} />
      {walls.length > 0 ? (
        <View style={styles.controls}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.wallStrip}
            contentContainerStyle={styles.walls}
          >
            {walls.map((wall) => (
              <Chip
                key={wall.uuid}
                label={wall.label}
                count={wall.count}
                selected={wall.uuid === wallUuid}
                onPress={() => setChosenWall(wall.uuid)}
                accessibilityLabel={wall.spoken}
              />
            ))}
          </ScrollView>
          <SegmentedControl fullWidth size="lg" value={period} onChange={setPeriod} options={PERIODS} />
          <View style={[styles.columns, { borderBottomColor: theme.border2 }]}>
            <Text variant="label" style={styles.rankColumn}>
              No.
            </Text>
            <Text variant="label" style={styles.flex} numberOfLines={1}>
              Climber{periodLabel ? ` · ${periodLabel}` : ''}
            </Text>
            <Text variant="label">Sends</Text>
          </View>
        </View>
      ) : null}
    </View>
  );

  if (walls.length === 0) {
    const looking = board !== null && (publicWalls.isPending || accountBoards.isLoading);
    return (
      <View style={[styles.flex, { paddingTop: insets.top, backgroundColor: theme.bgApp }]}>
        {header}
        <View style={styles.gutter}>
          {looking ? (
            <ActivityIndicator style={styles.loading} />
          ) : (
            <Section title="Walls">
              <Text variant="title3">{board ? 'No walls to rank yet' : 'Set up your board first'}</Text>
              <Text variant="small" tone="tertiary">
                {board
                  ? "Rankings count the sends logged on a Boardsesh wall: yours, or a gym's. No wall with this setup has any yet."
                  : 'Rankings follow the board you climb on.'}
              </Text>
              {!board ? (
                <Button title="Set up board" size="lg" fullWidth onPress={() => router.push('/board-setup')} />
              ) : status !== 'signedIn' ? (
                <Button title="Sign in" size="lg" fullWidth onPress={() => router.push('/login')} />
              ) : null}
            </Section>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.flex, { paddingTop: insets.top, backgroundColor: theme.bgApp }]}>
      <FlashList
        data={entries}
        keyExtractor={keyExtractor}
        renderItem={({ item }) => (
          <RankRow entry={item} isYou={item.userId === profile?.id} gradeFormat={gradeFormat} />
        )}
        extraData={[profile?.id, gradeFormat]}
        ListHeaderComponent={header}
        onEndReached={() => {
          if (leaderboard.hasNextPage && !leaderboard.isFetchingNextPage) void leaderboard.fetchNextPage();
        }}
        onEndReachedThreshold={0.6}
        refreshControl={
          <RefreshControl refreshing={leaderboard.isRefetching} onRefresh={() => void leaderboard.refetch()} />
        }
        ListEmptyComponent={
          leaderboard.isPending ? (
            <ActivityIndicator style={styles.loading} />
          ) : leaderboard.isError ? (
            <View style={styles.empty}>
              <Text variant="title3">Couldn&apos;t load rankings</Text>
              <Text tone="tertiary" align="center">
                {status === 'signedIn'
                  ? describeRequestError(leaderboard.error)
                  : 'Sign in to see this board’s rankings.'}
              </Text>
              <Button title="Try again" variant="secondary" onPress={() => void leaderboard.refetch()} />
            </View>
          ) : (
            <View style={styles.empty}>
              <Text variant="title3">Nobody on the board yet.</Text>
              <Text tone="tertiary" align="center">
                Log a send and the top spot is yours.
              </Text>
            </View>
          )
        }
        ListFooterComponent={leaderboard.isFetchingNextPage ? <ActivityIndicator style={styles.loading} /> : null}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  gutter: { paddingHorizontal: GUTTER },
  controls: { paddingHorizontal: GUTTER, gap: spacing.lg },
  // The chips run to the screen edges while the first lines up with the page.
  wallStrip: { marginHorizontal: -GUTTER },
  walls: { paddingHorizontal: GUTTER, gap: spacing.sm },
  columns: { height: 34, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderBottomWidth: 1 },
  rankColumn: { width: 24 },
  row: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: GUTTER,
    borderBottomWidth: 1,
  },
  youRow: { marginHorizontal: GUTTER - spacing.md, paddingHorizontal: spacing.md, borderRadius: radius.md },
  rank: { width: 24, fontSize: 12 },
  copy: { flex: 1, minWidth: 0, gap: 4 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { flexShrink: 1 },
  loading: { paddingVertical: spacing.xxl },
  empty: { alignItems: 'center', gap: spacing.sm, paddingVertical: 56, paddingHorizontal: spacing.xxl },
});
