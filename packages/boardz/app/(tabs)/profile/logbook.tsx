import { memo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useInfiniteQuery } from '@tanstack/react-query';
import { formatBoardDisplayName } from '@boardsesh/board-config';
import {
  GET_USER_ASCENTS_FEED,
  type AscentFeedItem,
  type GetUserAscentsFeedQueryResponse,
} from '@boardsesh/graphql/operations/ticks';
import { describeRequestError, graphqlRequest } from '../../../src/api/graphql-client';
import { useAuth } from '../../../src/auth/auth-provider';
import { gradeBand, gradeLabel, type GradeDisplayFormat } from '../../../src/grades/grades';
import { useDebouncedValue } from '../../../src/hooks/use-debounced-value';
import { usePreferences } from '../../../src/settings/preferences-provider';
import { useDeleteTick } from '../../../src/ticks/use-ticks';
import { Button } from '../../../src/ui/Button';
import { GradeBadge } from '../../../src/ui/GradeBadge';
import { Search } from '../../../src/ui/icons';
import { SegmentedControl } from '../../../src/ui/SegmentedControl';
import { Text } from '../../../src/ui/Text';
import { TextField } from '../../../src/ui/TextField';
import { TopBar } from '../../../src/ui/TopBar';
import { useTheme } from '../../../src/ui/theme';
import { GUTTER, spacing } from '../../../src/ui/tokens';

const PAGE_SIZE = 30;
type StatusMode = 'both' | 'send' | 'attempt';
const STATUS_LABEL = { flash: 'Flash', send: 'Send', attempt: 'Attempts' } as const;
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', year: '2-digit' });

const keyExtractor = (item: AscentFeedItem) => item.uuid;

const AscentRow = memo(function AscentRow({
  ascent,
  gradeFormat,
  onLongPress,
}: {
  ascent: AscentFeedItem;
  gradeFormat: GradeDisplayFormat;
  onLongPress: (ascent: AscentFeedItem) => void;
}) {
  const theme = useTheme();
  // The climber's own grade when they gave one, else the climb's.
  const grade = ascent.difficultyName ?? ascent.consensusDifficultyName;
  const result =
    ascent.status === 'attempt'
      ? `${STATUS_LABEL.attempt} ×${ascent.attemptCount}`
      : ascent.status === 'send'
        ? `${STATUS_LABEL.send} · ${ascent.attemptCount}`
        : STATUS_LABEL.flash;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Long press to remove it from your logbook"
      onLongPress={() => onLongPress(ascent)}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: theme.border1, backgroundColor: pressed ? theme.bgSurface2 : 'transparent' },
      ]}
    >
      <GradeBadge
        label={gradeLabel(grade, gradeFormat)}
        band={gradeBand(grade)}
        variant={ascent.status === 'attempt' ? 'outline' : 'solid'}
        size="sm"
      />
      <View style={styles.copy}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {ascent.climbName}
        </Text>
        <Text variant="mono" tone="tertiary" numberOfLines={1}>
          {formatBoardDisplayName(ascent.boardType)} · {ascent.angle}° ·{' '}
          {DATE_FORMAT.format(new Date(ascent.climbedAt))}
        </Text>
      </View>
      <Text variant="label" tone={ascent.status === 'flash' ? 'primary' : 'tertiary'}>
        {result}
      </Text>
    </Pressable>
  );
});

export default function LogbookScreen() {
  const theme = useTheme();
  const { profile } = useAuth();
  const { gradeFormat } = usePreferences();
  const deleteTick = useDeleteTick();
  const [query, setQuery] = useState('');
  const [statusMode, setStatusMode] = useState<StatusMode>('both');
  const climbName = useDebouncedValue(query.trim(), 300);

  const feed = useInfiniteQuery({
    queryKey: ['logbook', profile?.id, climbName, statusMode],
    queryFn: async ({ pageParam }) =>
      (
        await graphqlRequest<GetUserAscentsFeedQueryResponse>(GET_USER_ASCENTS_FEED, {
          userId: profile?.id,
          input: {
            limit: PAGE_SIZE,
            offset: pageParam,
            sortBy: 'recent',
            statusMode,
            ...(climbName ? { climbName } : {}),
          },
        })
      ).userAscentsFeed,
    initialPageParam: 0,
    getNextPageParam: (lastPage, _pages, lastOffset) => (lastPage.hasMore ? lastOffset + PAGE_SIZE : undefined),
    enabled: profile !== null,
  });
  const ascents = feed.data?.pages.flatMap((page) => page.items) ?? [];
  const total = feed.data?.pages[0]?.totalCount;

  const confirmDelete = (ascent: AscentFeedItem) =>
    Alert.alert('Remove from your logbook?', `${STATUS_LABEL[ascent.status]} of ${ascent.climbName}`, [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () =>
          deleteTick.mutate(
            { uuid: ascent.uuid, boardType: ascent.boardType, climbUuid: ascent.climbUuid },
            { onError: (error) => Alert.alert('Not removed', describeRequestError(error)) },
          ),
      },
    ]);

  const header = (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <Text variant="title1">Logbook</Text>
        {total !== undefined ? (
          <Text variant="mono" tone="tertiary" style={styles.count}>
            {total.toLocaleString()}
          </Text>
        ) : null}
      </View>
      <TextField
        icon={Search}
        placeholder="Search your ascents"
        value={query}
        onChangeText={setQuery}
        clearable
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />
      <SegmentedControl
        fullWidth
        size="lg"
        value={statusMode}
        onChange={setStatusMode}
        options={[
          { value: 'both', label: 'Everything' },
          { value: 'send', label: 'Sends' },
          { value: 'attempt', label: 'Attempts' },
        ]}
      />
      <View style={[styles.rule, { backgroundColor: theme.border2 }]} />
    </View>
  );

  return (
    <View style={[styles.flex, { backgroundColor: theme.bgApp }]}>
      <TopBar label="All ascents" />
      <FlashList
        data={ascents}
        keyExtractor={keyExtractor}
        renderItem={({ item }) => <AscentRow ascent={item} gradeFormat={gradeFormat} onLongPress={confirmDelete} />}
        extraData={gradeFormat}
        ListHeaderComponent={header}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onEndReached={() => {
          if (feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
        }}
        onEndReachedThreshold={0.6}
        ListEmptyComponent={
          feed.isPending ? (
            <ActivityIndicator style={styles.loading} />
          ) : feed.isError ? (
            <View style={styles.empty}>
              <Text tone="tertiary" align="center">
                {describeRequestError(feed.error)}
              </Text>
              <Button title="Try again" variant="secondary" onPress={() => void feed.refetch()} />
            </View>
          ) : (
            <View style={styles.empty}>
              <Text variant="title3">{climbName ? 'No match.' : 'Nothing logged yet.'}</Text>
              <Text tone="tertiary" align="center">
                {climbName ? 'Try another name.' : 'Your sends will land here. Go crush.'}
              </Text>
            </View>
          )
        }
        ListFooterComponent={feed.isFetchingNextPage ? <ActivityIndicator style={styles.loading} /> : null}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { paddingHorizontal: GUTTER, gap: spacing.md },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  count: { fontSize: 12 },
  rule: { height: 1, marginTop: spacing.xs, marginHorizontal: -GUTTER },
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: GUTTER,
    borderBottomWidth: 1,
  },
  copy: { flex: 1, minWidth: 0, gap: 3 },
  loading: { paddingVertical: spacing.xl },
  empty: { alignItems: 'center', gap: spacing.sm, padding: spacing.xxl },
});
