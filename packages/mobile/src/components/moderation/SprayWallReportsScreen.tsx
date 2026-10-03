import { memo, useCallback, useMemo, useRef } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import type { SprayWallReportReason } from '@boardsesh/graphql/operations/spray-walls';
import { Text } from '../Text';
import { Button } from '../Button';
import { AppMenu, type AppMenuAction } from '../AppMenu';
import { ActivityIndicator } from '../ActivityIndicator';
import { OfflineState } from '../OfflineState';
import { useTheme } from '../../providers/theme-provider';
import { useOfflineQueryState } from '../../hooks/use-offline-query-state';
import { useConnectivity } from '../../lib/connectivity/use-connectivity';
import {
  useSprayModerationAccess,
  useSprayWallReports,
  useReviewSprayWall,
} from '../../lib/spray/use-spray-moderation';
import { groupSprayWallReports, type SprayWallReportGroup } from '../spray-wall/spray-report-presenters';
import { spacing, borderRadius } from '../../theme/tokens';

const keyExtractor = (group: SprayWallReportGroup) => group.wallUuid;

const SprayWallReportCard = memo(function SprayWallReportCard({
  group,
  onRefreshPhoto,
  canReview,
}: {
  group: SprayWallReportGroup;
  onRefreshPhoto: () => void;
  canReview: boolean;
}) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
  const { effectiveOffline } = useConnectivity();
  const review = useReviewSprayWall();
  const failedPhoto = useRef<string | null>(null);
  const retryPhoto = useCallback(() => {
    const photoUrl = group.photo?.url;
    if (!photoUrl || failedPhoto.current === photoUrl) return;
    failedPhoto.current = photoUrl;
    onRefreshPhoto();
  }, [group.photo?.url, onRefreshPhoto]);
  const labels: Record<SprayWallReportReason, string> = {
    INAPPROPRIATE: t('sprayModeration.reasons.inappropriate'),
    NOT_A_WALL: t('sprayModeration.reasons.notAWall'),
    PERSONAL_INFO: t('sprayModeration.reasons.personalInfo'),
    OTHER: t('sprayModeration.reasons.other'),
  };
  const actions = useMemo<AppMenuAction[]>(
    () => [
      {
        label: t('sprayModeration.hide'),
        destructive: true,
        disabled: !canReview || review.isPending || effectiveOffline,
      },
      {
        label: group.hidden ? t('sprayModeration.unhide') : t('sprayModeration.keepVisible'),
        disabled: !canReview || review.isPending || effectiveOffline,
      },
    ],
    [t, group.hidden, canReview, review.isPending, effectiveOffline],
  );
  const choose = useCallback(
    (index: number) => {
      if (!canReview || review.isPending || effectiveOffline) return;
      review.mutate({ input: { uuid: group.wallUuid, hidden: index === 0 } });
    },
    [canReview, review, effectiveOffline, group.wallUuid],
  );
  const photoAvailable = group.photo && Date.parse(group.photo.expiresAt) > Date.now();
  return (
    <View style={[styles.card, { backgroundColor: systemColors.secondaryBackground }]}>
      <Text variant="title2">{group.wallName}</Text>
      {group.hidden ? <Text variant="caption1">{t('sprayModeration.hidden')}</Text> : null}
      {photoAvailable && group.photo ? (
        <Image
          source={{ uri: group.photo.url }}
          style={styles.photo}
          contentFit="contain"
          cachePolicy="none"
          onError={retryPhoto}
          accessibilityLabel={t('sprayModeration.photoLabel', { wall: group.wallName })}
        />
      ) : (
        <Text color={systemColors.secondaryLabel}>{t('sprayModeration.noPhoto')}</Text>
      )}
      <Text variant="footnote">{t('sprayModeration.reportCount', { count: group.reportCount })}</Text>
      {group.reasons.map((reason) => (
        <Text key={reason} color={systemColors.secondaryLabel}>
          {labels[reason]}
        </Text>
      ))}
      <AppMenu label={t('sprayModeration.review')} actions={actions} onSelectIndex={choose} />
      {review.isPending ? <ActivityIndicator /> : null}
      {review.isError ? <Text accessibilityLiveRegion="polite">{t('sprayModeration.reviewError')}</Text> : null}
    </View>
  );
});

export function SprayWallReportsScreen() {
  const { t } = useTranslation('boards');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const { canReview, sessionScope } = useSprayModerationAccess();
  const {
    data: reports,
    status,
    fetchStatus,
    isPending,
    isError,
    isRefetching,
    refetch,
  } = useSprayWallReports(canReview, sessionScope);
  const groups = useMemo(() => groupSprayWallReports(reports ?? []), [reports]);
  const offline = useOfflineQueryState({ status, fetchStatus, data: reports });
  const refresh = useCallback(() => {
    if (canReview) void refetch();
  }, [canReview, refetch]);
  const renderItem = useCallback(
    ({ item }: { item: SprayWallReportGroup }) => (
      <SprayWallReportCard group={item} onRefreshPhoto={refresh} canReview={canReview} />
    ),
    [refresh, canReview],
  );
  if (!canReview)
    return (
      <View style={styles.state}>
        <Text>{t('sprayModeration.unavailable')}</Text>
      </View>
    );
  return (
    <View style={[styles.flex, { backgroundColor: systemColors.background }]}>
      <FlashList
        data={groups}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refresh} tintColor={brandColors.primary} />
        }
        ListEmptyComponent={
          offline.isBlocked && offline.reason ? (
            <OfflineState reason={offline.reason} onRetry={refresh} />
          ) : isPending ? (
            <View style={styles.state}>
              <ActivityIndicator size="large" />
            </View>
          ) : isError ? (
            <View style={styles.state}>
              <Text>{t('sprayModeration.loadError')}</Text>
              <Button title={tCommon('actions.retry')} onPress={refresh} />
            </View>
          ) : (
            <View style={styles.state}>
              <Text variant="headline">{t('sprayModeration.empty')}</Text>
            </View>
          )
        }
      />
    </View>
  );
}
const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: spacing[4], paddingBottom: spacing[8] },
  card: { padding: spacing[4], marginBottom: spacing[4], borderRadius: borderRadius.lg, gap: spacing[2] },
  photo: { width: '100%', height: 280 },
  state: { padding: spacing[8], gap: spacing[4], alignItems: 'center' },
});
