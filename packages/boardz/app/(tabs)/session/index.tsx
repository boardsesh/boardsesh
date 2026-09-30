import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  LayoutAnimation,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import type { Climb } from '@boardsesh/shared-schema';
import { describeRequestError } from '../../../src/api/graphql-client';
import { useAuth } from '../../../src/auth/auth-provider';
import { useConnectionState } from '../../../src/ble/use-connection-state';
import { useBoard } from '../../../src/board/board-provider';
import { ClimbRow } from '../../../src/climbs/ClimbRow';
import { CLIMB_SORTS, SORT_LABELS, withSort } from '../../../src/climbs/climb-filters';
import { GradeRangeSlider } from '../../../src/climbs/GradeRangeSlider';
import { useClimbFilters } from '../../../src/climbs/climb-filters-provider';
import { useClimbSequence } from '../../../src/climbs/climb-sequence';
import { useSessionClimbs } from '../../../src/climbs/use-session-climbs';
import { gradeOptions } from '../../../src/grades/grades';
import { useDebouncedValue } from '../../../src/hooks/use-debounced-value';
import { useNow } from '../../../src/hooks/use-now';
import { climbStatuses, formatElapsed, summarizeSession } from '../../../src/session/session';
import { useSession } from '../../../src/session/session-provider';
import { usePreferences } from '../../../src/settings/preferences-provider';
import { useSentClimbs } from '../../../src/ticks/use-sent-climbs';
import { Button } from '../../../src/ui/Button';
import { ConnectionPill } from '../../../src/ui/ConnectionPill';
import { Icon } from '../../../src/ui/Icon';
import { IconButton } from '../../../src/ui/IconButton';
import { ArrowDown, Search, SlidersHorizontal, X } from '../../../src/ui/icons';
import { LedDot } from '../../../src/ui/LedDot';
import { PageHeader } from '../../../src/ui/PageHeader';
import { SegmentedControl } from '../../../src/ui/SegmentedControl';
import { Text } from '../../../src/ui/Text';
import { TextField } from '../../../src/ui/TextField';
import { LED, useTheme } from '../../../src/ui/theme';
import { GUTTER, spacing } from '../../../src/ui/tokens';

const keyExtractor = (climb: Climb) => climb.uuid;

type StripToggle = 'bench' | 'unsent';

/** The running session beside the title: its clock and sends, or a Start button. */
function SessionReadout() {
  const theme = useTheme();
  const { session, start, end } = useSession();
  const now = useNow(1000, session !== null);
  if (!session) {
    return <Button title="Start session" variant="secondary" size="sm" onPress={start} />;
  }
  const summary = summarizeSession(session, now);
  const clock = formatElapsed(summary.durationMs);
  const confirmEnd = () =>
    Alert.alert(
      'End this session?',
      `${clock} · ${summary.sends} sent · ${summary.attempts} ${summary.attempts === 1 ? 'try' : 'tries'}. Your climbs stay in your logbook.`,
      [
        { text: 'Keep climbing', style: 'cancel' },
        {
          text: 'End session',
          style: 'destructive',
          onPress: () => {
            end();
            router.push('/session-summary');
          },
        },
      ],
    );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Session running, ${clock}, ${summary.sends} sent`}
      accessibilityHint="Ends the session"
      onPress={confirmEnd}
      hitSlop={spacing.sm}
      style={styles.readout}
    >
      <LedDot color={LED.green} />
      <Text variant="mono" monospacedDigits style={styles.clock}>
        {clock}
      </Text>
      <Text variant="mono" color={theme.fg3} style={styles.clockMeta}>
        · {summary.sends} SENT
      </Text>
    </Pressable>
  );
}

export default function SessionScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { board } = useBoard();
  const { status } = useAuth();
  const connection = useConnectionState();
  const { filters, setFilters, query, setQuery } = useClimbFilters();
  const { gradeFormat } = usePreferences();
  const { session } = useSession();
  const { setClimbs } = useClimbSequence();
  const searchName = useDebouncedValue(query, 300);
  const search = useSessionClimbs(board, filters, searchName);
  const sentBefore = useSentClimbs(board);
  const listRef = useRef<FlashListRef<Climb>>(null);

  // A new sort, filter or search starts from the top: the first climbs are what changed.
  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [filters, searchName]);

  const { climbs, total } = search;
  const thisSession = climbStatuses(session?.ticks ?? []);
  const isSent = (uuid: string) => {
    const status = thisSession.get(uuid);
    return (status !== undefined && status !== 'attempt') || sentBefore.has(uuid);
  };

  const openClimb = (climb: Climb) => {
    setClimbs(climbs);
    router.push({ pathname: '/climb/[uuid]', params: { uuid: climb.uuid } });
  };
  const openFilters = () => router.push('/filters');

  // Search stays a button until it's wanted, and stays open while it holds a query.
  const [searching, setSearching] = useState(query.length > 0);
  const openSearch = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setSearching(true);
  };
  const closeSearch = () => {
    Keyboard.dismiss();
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setQuery('');
    setSearching(false);
  };

  const toggles: StripToggle[] = [
    ...(filters.benchmarksOnly ? (['bench'] as const) : []),
    ...(filters.hideSent ? (['unsent'] as const) : []),
  ];
  const onStrip = (next: StripToggle[]) =>
    setFilters({ ...filters, benchmarksOnly: next.includes('bench'), hideSent: next.includes('unsent') });
  const nextSort = () => {
    const index = CLIMB_SORTS.indexOf(filters.sort);
    setFilters(withSort(filters, CLIMB_SORTS[(index + 1) % CLIMB_SORTS.length]));
  };

  const meta = board ? `${board.name} · ${board.angle}°` : 'No board yet';
  const header = (
    <View>
      <PageHeader
        title="Session"
        meta={meta}
        aside={<SessionReadout />}
        right={<ConnectionPill state={connection} onPress={() => router.push('/connect')} />}
      />
      {board ? (
        <View style={styles.controls}>
          <GradeRangeSlider
            grades={gradeOptions(board.boardName, gradeFormat)}
            minGrade={filters.minGrade}
            maxGrade={filters.maxGrade}
            onChange={(range) => setFilters({ ...filters, ...range })}
          />
          <View style={styles.toolRow}>
            {searching ? (
              <>
                <View style={styles.flex}>
                  <TextField
                    icon={Search}
                    placeholder="Search climbs"
                    value={query}
                    onChangeText={setQuery}
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                  />
                </View>
                <IconButton icon={X} label="Close search" variant="secondary" size="field" onPress={closeSearch} />
              </>
            ) : (
              <>
                <SegmentedControl
                  multiple
                  size="lg"
                  value={toggles}
                  onChange={onStrip}
                  options={[
                    { value: 'bench', label: 'Benchmarks' },
                    ...(status === 'signedIn' ? [{ value: 'unsent' as const, label: 'Not sent' }] : []),
                  ]}
                />
                <View style={styles.flex} />
                <IconButton icon={Search} label="Search climbs" variant="secondary" size="field" onPress={openSearch} />
                <IconButton
                  icon={SlidersHorizontal}
                  label="All filters"
                  variant="secondary"
                  size="field"
                  onPress={openFilters}
                />
              </>
            )}
          </View>
        </View>
      ) : null}
      {board ? (
        <View style={[styles.columns, { borderBottomColor: theme.border2 }]}>
          <View style={styles.count}>
            <Text variant="label" numberOfLines={1}>
              {total !== undefined ? `${total.toLocaleString()} ${total === 1 ? 'climb' : 'climbs'}` : 'Climbs'}
            </Text>
            {/* The climbs below are the last results while the new ones load. */}
            {search.isPlaceholderData ? <ActivityIndicator size="small" color={theme.fg3} /> : null}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Sorted by ${SORT_LABELS[filters.sort]}`}
            accessibilityHint="Changes the order"
            hitSlop={spacing.sm}
            onPress={nextSort}
            style={styles.sort}
          >
            <Text variant="label" tone="secondary">
              {SORT_LABELS[filters.sort]}
            </Text>
            <Icon icon={ArrowDown} size={11} color={theme.fg2} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );

  if (!board) {
    return (
      <View style={[styles.flex, { paddingTop: insets.top, backgroundColor: theme.bgApp }]}>
        {header}
        <View style={styles.empty}>
          <Text variant="title3">No board yet</Text>
          <Text tone="tertiary" align="center">
            Set up your board on Home to see its climbs here.
          </Text>
          <Button title="Set up board" onPress={() => router.push('/board-setup')} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.flex, { paddingTop: insets.top, backgroundColor: theme.bgApp }]}>
      <FlashList
        ref={listRef}
        data={climbs}
        keyExtractor={keyExtractor}
        renderItem={({ item }) => (
          <ClimbRow climb={item} gradeFormat={gradeFormat} sent={isSent(item.uuid)} onPress={openClimb} />
        )}
        extraData={[thisSession, sentBefore, gradeFormat]}
        ListHeaderComponent={header}
        contentInsetAdjustmentBehavior="never"
        // FlashList keeps the top row in place when data changes. After a re-sort
        // that row has moved, so the list jumped after it. This list only appends.
        maintainVisibleContentPosition={{ disabled: true }}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onEndReached={() => {
          search.fetchMore();
        }}
        onEndReachedThreshold={0.6}
        refreshControl={<RefreshControl refreshing={search.isRefetching} onRefresh={() => void search.refetch()} />}
        ListEmptyComponent={
          search.isPending ? (
            <ActivityIndicator style={styles.loading} />
          ) : search.isError ? (
            <View style={styles.empty}>
              <Text variant="title3">Couldn&apos;t load climbs</Text>
              <Text tone="tertiary" align="center">
                {describeRequestError(search.error)}
              </Text>
              <Button title="Try again" variant="secondary" onPress={() => void search.refetch()} />
            </View>
          ) : (
            <View style={styles.empty}>
              <Text variant="title3">Nothing here. Too spicy?</Text>
              <Text tone="tertiary" align="center">
                Loosen a filter or two.
              </Text>
            </View>
          )
        }
        ListFooterComponent={search.isFetchingMore ? <ActivityIndicator style={styles.loading} /> : null}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  readout: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 32 },
  clock: { fontSize: 13, lineHeight: 16 },
  clockMeta: { fontSize: 11, lineHeight: 14, letterSpacing: 0.4 },
  controls: { gap: spacing.md },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: GUTTER },
  columns: {
    marginTop: spacing.lg,
    height: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: GUTTER,
    borderBottomWidth: 1,
  },
  count: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sort: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 30 },
  loading: { paddingVertical: spacing.xxl },
  empty: { alignItems: 'center', gap: spacing.sm, paddingVertical: 56, paddingHorizontal: spacing.xxl },
});
