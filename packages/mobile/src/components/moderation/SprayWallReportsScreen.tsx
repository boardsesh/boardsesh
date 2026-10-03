import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

type ReviewState = 'pending' | 'error';
type ReportRow = { group: SprayWallReportGroup; reviewState?: ReviewState };
const EMPTY_REVIEW_STATES: ReadonlyMap<string, ReviewState> = new Map();
const keyExtractor = (row: ReportRow) => row.group.wallUuid;

const SprayWallReportCard = memo(function SprayWallReportCard({
  group,
  onRefreshPhoto,
  canReview,
  effectiveOffline,
  reviewState,
  onReview,
}: {
  group: SprayWallReportGroup;
  onRefreshPhoto: () => void;
  canReview: boolean;
  effectiveOffline: boolean;
  reviewState?: ReviewState;
  onReview: (wallUuid: string, hidden: boolean) => void;
}) {
  const { t } = useTranslation('boards');
  const { systemColors } = useTheme();
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
        disabled: !canReview || reviewState === 'pending' || effectiveOffline,
      },
      {
        label: group.hidden ? t('sprayModeration.unhide') : t('sprayModeration.keepVisible'),
        disabled: !canReview || reviewState === 'pending' || effectiveOffline,
      },
    ],
    [t, group.hidden, canReview, reviewState, effectiveOffline],
  );
  const choose = useCallback(
    (index: number) => {
      if (!canReview || reviewState === 'pending' || effectiveOffline) return;
      onReview(group.wallUuid, index === 0);
    },
    [canReview, reviewState, effectiveOffline, group.wallUuid, onReview],
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
      {reviewState === 'pending' ? <ActivityIndicator /> : null}
      {reviewState === 'error' ? (
        <Text accessibilityLiveRegion="polite">{t('sprayModeration.reviewError')}</Text>
      ) : null}
    </View>
  );
});

export function SprayWallReportsScreen() {
  const { t } = useTranslation('boards');
  const { t: tCommon } = useTranslation('common');
  const { systemColors, brandColors } = useTheme();
  const { canReview, sessionScope } = useSprayModerationAccess();
  const { effectiveOffline } = useConnectivity();
  const { mutateAsync: reviewWall } = useReviewSprayWall();
  const [reviewStates, setReviewStates] = useState(EMPTY_REVIEW_STATES);
  const inFlightWalls = useRef(new Set<string>());
  const currentSession = useRef(sessionScope);
  currentSession.current = sessionScope;
  useEffect(() => {
    currentSession.current = sessionScope;
    inFlightWalls.current.clear();
    setReviewStates(EMPTY_REVIEW_STATES);
    return () => {
      currentSession.current = -1;
    };
  }, [sessionScope]);
  const onReview = useCallback(
    (wallUuid: string, hidden: boolean) => {
      if (!canReview || effectiveOffline || inFlightWalls.current.has(wallUuid)) return;
      inFlightWalls.current.add(wallUuid);
      setReviewStates((priorStates) => new Map(priorStates).set(wallUuid, 'pending'));
      void reviewWall({ input: { uuid: wallUuid, hidden } })
        .then(() => {
          if (currentSession.current !== sessionScope) return;
          setReviewStates((priorStates) => {
            const nextStates = new Map(priorStates);
            nextStates.delete(wallUuid);
            return nextStates;
          });
        })
        .catch(() => {
          if (currentSession.current === sessionScope) {
            setReviewStates((priorStates) => new Map(priorStates).set(wallUuid, 'error'));
          }
        })
        .finally(() => {
          if (currentSession.current === sessionScope) inFlightWalls.current.delete(wallUuid);
        });
    },
    [canReview, effectiveOffline, reviewWall, sessionScope],
  );
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
  const rows = useMemo<ReportRow[]>(
    () => groups.map((group) => ({ group, reviewState: reviewStates.get(group.wallUuid) })),
    [groups, reviewStates],
  );
  const offline = useOfflineQueryState({ status, fetchStatus, data: reports });
  const refresh = useCallback(() => {
    if (canReview) void refetch();
  }, [canReview, refetch]);
  const renderItem = useCallback(
    ({ item }: { item: ReportRow }) => (
      <SprayWallReportCard
        group={item.group}
        onRefreshPhoto={refresh}
        canReview={canReview}
        effectiveOffline={effectiveOffline}
        reviewState={item.reviewState}
        onReview={onReview}
      />
    ),
    [refresh, canReview, effectiveOffline, onReview],
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
        data={rows}
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
