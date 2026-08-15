import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { GLOBAL_SCOPE, type Scope } from '@boardsesh/leaderboard';
import { Text } from '../Text';
import { ActivityIndicator } from '../ActivityIndicator';
import { OfflineState } from '../OfflineState';
import { SegmentedControl } from '../SegmentedControl';
import { useOfflineQueryState } from '../../hooks/use-offline-query-state';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { useStandings, type StandingsEntry, type StandingsWindow } from '../../lib/graphql/hooks/use-standings';
import { StandingsRow } from './StandingsRow';
import { useScopeKindLabel } from './scope-labels';
import { ViewerStandingCard } from './ViewerStandingCard';

const EMPTY_ENTRIES: StandingsEntry[] = [];

/** Hoisted per the mobile performance checklist — never rebuilt per render. */
const keyExtractor = (entry: StandingsEntry) => entry.userId;

type StandingsScreenProps = {
  initialScope?: Scope;
};

export function StandingsScreen({ initialScope = GLOBAL_SCOPE }: StandingsScreenProps) {
  const { t } = useTranslation('boards');
  const router = useRouter();
  const { systemColors } = useTheme();
  const { scrollBottomPadding } = useBottomChromeMetrics();
  const scopeKindLabel = useScopeKindLabel();

  const [scope] = useState<Scope>(initialScope);
  const [window, setWindow] = useState<StandingsWindow>('month');

  const query = useStandings(scope, window);
  const pages = query.data?.pages;

  const entries = useMemo<StandingsEntry[]>(() => pages?.flatMap((page) => page.entries) ?? EMPTY_ENTRIES, [pages]);
  const head = pages?.[0];

  // An offline fetch *pauses* rather than erroring under
  // `networkMode: 'offlineFirst'`, so it satisfies neither the pending nor the
  // error branch and a naive spinner would never clear. Offline outranks both.
  const offlineState = useOfflineQueryState(query);
  const showOffline = offlineState.isBlocked && entries.length === 0;
  const showSpinner = !showOffline && query.isPending && entries.length === 0;
  const showError = !showOffline && query.isError && entries.length === 0;

  const windowOptions = useMemo(
    () => [
      { key: 'month' as const, label: t('standings.window.month') },
      { key: 'week' as const, label: t('standings.window.week') },
    ],
    [t],
  );

  const handleOpenProfile = useCallback(
    (userId: string) => {
      router.push(`/users/${userId}`);
    },
    [router],
  );

  const handleRefresh = useCallback(() => {
    void query.refetch();
  }, [query]);

  // No `.length` and no inline closure in the deps — both are review failures
  // on a list this long, because either rebuilds every row on every page fetch.
  const renderItem = useCallback(
    ({ item }: { item: StandingsEntry }) => <StandingsRow entry={item} onPress={handleOpenProfile} />,
    [handleOpenProfile],
  );

  // One page per end-reach. Never a drain-until-hasMore loop.
  const handleEndReached = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      void query.fetchNextPage();
    }
  }, [query]);

  const header = useMemo(() => {
    if (!head) return null;
    const scopeLabel = head.resolvedScope.label || scopeKindLabel(head.resolvedScope.kind);

    return (
      <View style={styles.header}>
        <Text variant="title3">{scopeLabel}</Text>
        <Text variant="footnote" color={systemColors.secondaryLabel}>
          {t('standings.climberCount', { count: head.totalCount })}
        </Text>

        <SegmentedControl
          options={windowOptions}
          selectedKey={window}
          onSelect={setWindow}
          trackColor={systemColors.fill}
          accessibilityLabel={t('standings.window.label')}
        />

        {head.demotionReason ? (
          // Never a silent demotion: say which board this actually is, and why.
          <View style={[styles.notice, { backgroundColor: systemColors.fill }]}>
            <Text variant="footnote" color={systemColors.secondaryLabel}>
              {head.demotionReason === 'empty'
                ? t('standings.demoted.empty', { requested: head.requestedScope.label || '', scope: scopeLabel })
                : t('standings.demoted.unknown', { scope: scopeLabel })}
            </Text>
          </View>
        ) : null}

        {head.viewer ? <ViewerStandingCard viewer={head.viewer} cohortSize={head.totalCount} /> : null}
      </View>
    );
  }, [head, scopeKindLabel, systemColors.fill, systemColors.secondaryLabel, t, window, windowOptions]);

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Text variant="caption1" color={systemColors.secondaryLabel}>
          {t('standings.footnote.metric')}
        </Text>
        {head && head.coverage < 1 ? (
          <Text variant="caption1" color={systemColors.secondaryLabel}>
            {t('standings.footnote.attribution')}
          </Text>
        ) : null}
      </View>
    ),
    [head, systemColors.secondaryLabel, t],
  );

  // "You're offline" and "your wall is quiet" are different sentences and must
  // never collapse into one — `reason` is what keeps them apart, so this branch
  // is gated on having one rather than defaulting to a guess.
  if (showOffline && offlineState.reason) {
    return <OfflineState reason={offlineState.reason} onRetry={handleRefresh} />;
  }

  if (showSpinner) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (showError) {
    return (
      <View style={styles.centered}>
        <Text variant="body" color={systemColors.secondaryLabel}>
          {t('standings.error')}
        </Text>
      </View>
    );
  }

  return (
    <FlashList
      data={entries}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      onEndReached={handleEndReached}
      onEndReachedThreshold={0.5}
      contentContainerStyle={{ paddingBottom: scrollBottomPadding + spacing[4] }}
      refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={handleRefresh} />}
    />
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
    gap: spacing[3],
  },
  notice: {
    padding: spacing[3],
    borderRadius: spacing[2],
  },
  footer: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
    gap: spacing[1],
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing[6],
  },
});
