import { memo, useCallback, useMemo } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { Stack, useFocusEffect, useIsFocused, useRouter } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';
import type { AppBugReport } from '@boardsesh/shared-schema';
import { useAuth } from '../../providers/auth-provider';
import { useStoredUserId } from '../../hooks/use-current-user-id';
import { useStackScreenOptions } from '../../hooks/use-stack-screen-options';
import { useBottomChromeMetrics } from '../../hooks/use-bottom-chrome-metrics';
import { useOfflineQueryState } from '../../hooks/use-offline-query-state';
import { useMyAppBugReports } from '../../lib/feedback/use-bug-reports';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { useTheme } from '../../providers/theme-provider';
import { spacing } from '../../theme/tokens';
import { ActivityIndicator } from '../ActivityIndicator';
import { Button } from '../Button';
import { Text } from '../Text';
import { OfflineState } from '../OfflineState';
import { PressableSurface } from '../PressableSurface';
import { bugReportStatusLabel } from './bug-report-status';

const EMPTY_REPORTS: AppBugReport[] = [];
const reportKey = (report: AppBugReport) => report.id;

const BugReportRow = memo(function BugReportRow({
  report,
  onPress,
}: {
  report: AppBugReport;
  onPress: (report: AppBugReport) => void;
}) {
  const { t } = useTranslation('settings');
  const { systemColors } = useTheme();
  const handlePress = useCallback(() => onPress(report), [onPress, report]);
  return (
    <PressableSurface
      accessibilityRole="button"
      onPress={handlePress}
      style={[styles.row, { borderBottomColor: systemColors.separator }]}
    >
      <Text variant="body" numberOfLines={3}>
        {report.comment}
      </Text>
      <Text variant="footnote" tone="secondary">
        {bugReportStatusLabel(report.status, t)} · {formatRelativeTime(report.createdAt)}
      </Text>
      {report.lastMessagePreview ? (
        <Text variant="subheadline" tone="secondary" numberOfLines={2}>
          {report.lastMessagePreview}
        </Text>
      ) : null}
    </PressableSurface>
  );
});

export default function BugReportsScreen() {
  const { t } = useTranslation('settings');
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { userId, isLoading: accountLoading } = useStoredUserId(isAuthenticated);
  const { systemColors } = useTheme();
  const screenOptions = useStackScreenOptions();
  const bottomChrome = useBottomChromeMetrics();
  const router = useRouter();
  const focused = useIsFocused();
  const query = useMyAppBugReports(isAuthenticated ? userId : undefined, focused);
  const { data, refetch, fetchNextPage, hasNextPage, isFetching, isFetchingNextPage, isRefetching } = query;
  const offline = useOfflineQueryState(query);
  const reports = useMemo(() => data?.pages.flatMap((page) => page.reports) ?? EMPTY_REPORTS, [data]);
  const handleRefresh = useCallback(() => {
    void refetch({ cancelRefetch: false });
  }, [refetch]);
  const handleLoadMore = useCallback(() => {
    if (focused && hasNextPage && !isFetching) void fetchNextPage({ cancelRefetch: false });
  }, [focused, hasNextPage, isFetching, fetchNextPage]);
  const openReport = useCallback(
    (report: AppBugReport) => {
      router.push({ pathname: '/bug-reports/[id]', params: { id: report.id } });
    },
    [router],
  );
  const signIn = useCallback(() => router.push('/auth/login'), [router]);
  const renderReport = useCallback(
    ({ item }: { item: AppBugReport }) => <BugReportRow report={item} onPress={openReport} />,
    [openReport],
  );

  useFocusEffect(
    useCallback(() => {
      if (isAuthenticated && userId) void refetch({ cancelRefetch: false });
    }, [isAuthenticated, userId, refetch]),
  );

  const loading = authLoading || accountLoading || (isAuthenticated && query.isPending);
  return (
    <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
      <Stack.Screen options={{ ...screenOptions, title: t('bugReports.title'), headerShown: true }} />
      {!isAuthenticated && !authLoading ? (
        <View style={styles.state}>
          <Button title={t('bugReports.signIn')} onPress={signIn} />
        </View>
      ) : (
        <FlashList
          data={reports}
          keyExtractor={reportKey}
          renderItem={renderReport}
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingBottom: bottomChrome.scrollBottomPadding + spacing[4] }}
          refreshControl={<RefreshControl refreshing={isRefetching && !isFetchingNextPage} onRefresh={handleRefresh} />}
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.5}
          ListEmptyComponent={
            offline.isBlocked && offline.reason ? (
              <OfflineState reason={offline.reason} onRetry={handleRefresh} />
            ) : loading ? (
              <View style={styles.state}>
                <ActivityIndicator size="large" />
              </View>
            ) : query.isError ? (
              <View style={styles.state}>
                <Text>{t('bugReports.loadError')}</Text>
                <Button title={t('bugReports.retry')} variant="text" onPress={handleRefresh} />
              </View>
            ) : (
              <View style={styles.state}>
                <Text tone="secondary">{t('bugReports.empty')}</Text>
              </View>
            )
          }
          ListFooterComponent={
            hasNextPage ? (
              <Button
                title={t('bugReports.loadMore')}
                variant="text"
                loading={isFetchingNextPage}
                onPress={handleLoadMore}
              />
            ) : null
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { padding: spacing[4], gap: spacing[2], borderBottomWidth: StyleSheet.hairlineWidth },
  state: { padding: spacing[6], gap: spacing[4], alignItems: 'center' },
});
