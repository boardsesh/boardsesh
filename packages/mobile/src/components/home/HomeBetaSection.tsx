import { memo, useCallback, type ReactNode } from 'react';
import { FlatList, StyleSheet, View, type ListRenderItemInfo } from 'react-native';
import { useTranslation } from 'react-i18next';
import { betaLinkIdentity } from '@boardsesh/shared-schema';
import { Button } from '../Button';
import { Icon } from '../Icon';
import { PressableSurface } from '../PressableSurface';
import { SHELF_HEADER_CONTENT_GAP, ShelfHeader } from '../ShelfHeader';
import { Text } from '../Text';
import { BetaVideoCard, BETA_CARD_HEIGHT, BETA_CARD_WIDTH } from '../play-drawer/BetaVideoCard';
import { useScopedRouter as useRouter } from '../../lib/routing/scoped-navigation';
import { useRecentBetaLinks, type RecentBetaVideo } from '../../lib/graphql/hooks';
import { openClimbInPlayDrawer } from '../../lib/open-climb-in-play-drawer';
import { hapticLight } from '../../lib/haptics';
import { useOfflineQueryState } from '../../hooks/use-offline-query-state';
import { useDrawerHost } from '../../providers/drawer-host-provider';
import { useTheme } from '../../providers/theme-provider';
import { borderRadius, spacing } from '../../theme/tokens';

// One page, never more: the shelf is a glance, not a feed.
const RECENT_BETA_LIMIT = 20;
const CARD_GAP = spacing[3];
const CARD_STEP = BETA_CARD_WIDTH + CARD_GAP;
// The list's leading padding (`listContent`), before the first card.
const LIST_INSET = spacing[4];
const SKELETON_KEYS = ['beta-skeleton-1', 'beta-skeleton-2', 'beta-skeleton-3'];

const keyExtractor = (video: RecentBetaVideo) => betaLinkIdentity(video.betaLink.link);
const getItemLayout = (_data: ArrayLike<RecentBetaVideo> | null | undefined, index: number) => ({
  length: CARD_STEP,
  offset: LIST_INSET + CARD_STEP * index,
  index,
});

function CardGap() {
  return <View style={styles.cardGap} />;
}

type HomeBetaSectionProps = {
  /** Home's selected board; the shelf keeps to its board type and layout. Null is every board. */
  boardType: string | null;
  layoutId: number | null;
  /** False until Home's scope has settled, so a cold start asks once, for the right board. */
  enabled: boolean;
};

/**
 * "Fresh beta": the newest community beta videos, as a horizontal shelf. It is
 * back from the Home of June 2026 (removed with the Climbing now rail, #5518),
 * now as a section a climber switches on. Each card opens the video; the climb
 * name under it opens the climb.
 *
 * Network only. Offline it says so and asks for nothing; the list is one page
 * of at most 20, virtualised.
 */
export const HomeBetaSection = memo(function HomeBetaSection({ boardType, layoutId, enabled }: HomeBetaSectionProps) {
  const { t } = useTranslation('feed');
  const { t: tCommon } = useTranslation('common');
  const { systemColors } = useTheme();
  const router = useRouter();
  const { openPlayDrawer } = useDrawerHost();
  const query = useRecentBetaLinks(RECENT_BETA_LIMIT, boardType, layoutId, enabled);
  const offline = useOfflineQueryState(query);
  const { refetch } = query;
  const handleRetry = useCallback(() => {
    void refetch();
  }, [refetch]);

  const openClimb = useCallback(
    (video: RecentBetaVideo) => {
      const climbUuid = video.betaLink.climb_uuid;
      const angle = video.betaLink.angle;
      if (!climbUuid || !video.boardType || angle == null) return;
      hapticLight();
      openClimbInPlayDrawer(
        { kind: 'ref', climbUuid, boardType: video.boardType, layoutId: video.layoutId, angle },
        { openPlayDrawer, router },
      );
    },
    [openPlayDrawer, router],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<RecentBetaVideo>) => <HomeBetaCard video={item} onOpenClimb={openClimb} />,
    [openClimb],
  );

  const title = boardType ? t('mobile.home.sections.beta.titleBoard') : t('mobile.home.sections.beta.title');
  const videos = query.data ?? [];
  const blockedOffline = offline.isBlocked && (offline.reason === 'offline' || offline.reason === 'offline_mode');

  let body;
  if (blockedOffline) {
    body = (
      <StateRow icon="offline.unavailable">
        {offline.reason === 'offline_mode'
          ? t('mobile.home.sections.beta.offlineMode')
          : t('mobile.home.sections.beta.offline')}
      </StateRow>
    );
  } else if (offline.isBlocked || query.isError) {
    body = (
      <StateRow
        icon="error"
        action={
          <Button
            title={tCommon('actions.retry')}
            variant="text"
            size="small"
            onPress={handleRetry}
            ignoreContainerSafeArea
          />
        }
      >
        {t('mobile.home.sections.beta.error')}
      </StateRow>
    );
  } else if (!enabled || query.isPending) {
    body = (
      <View style={styles.skeletonRow} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {SKELETON_KEYS.map((skeletonKey) => (
          <View key={skeletonKey} style={[styles.skeletonCard, { backgroundColor: systemColors.fill }]} />
        ))}
      </View>
    );
  } else if (videos.length === 0) {
    body = <StateRow icon="video">{t('mobile.home.sections.beta.empty')}</StateRow>;
  } else {
    body = (
      // FlatList, not FlashList: at most 20 fixed-size cards snapping on getItemLayout.
      <FlatList
        horizontal
        data={videos}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        getItemLayout={getItemLayout}
        ItemSeparatorComponent={CardGap}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        snapToInterval={CARD_STEP}
        decelerationRate="fast"
        snapToAlignment="start"
        initialNumToRender={4}
        maxToRenderPerBatch={4}
        windowSize={3}
      />
    );
  }

  return (
    <View style={styles.section} testID="home-section-beta">
      <ShelfHeader title={title} />
      <View style={styles.body}>{body}</View>
    </View>
  );
});

const HomeBetaCard = memo(function HomeBetaCard({
  video,
  onOpenClimb,
}: {
  video: RecentBetaVideo;
  onOpenClimb: (video: RecentBetaVideo) => void;
}) {
  const { t } = useTranslation('feed');
  const { systemColors } = useTheme();
  const handleOpenClimb = useCallback(() => onOpenClimb(video), [onOpenClimb, video]);
  const climbName = video.climbName ?? t('mobile.home.sections.beta.unknownClimb');
  const canOpenClimb = !!video.betaLink.climb_uuid && video.betaLink.angle != null;
  return (
    <View style={styles.card}>
      <BetaVideoCard link={video.betaLink} />
      <PressableSurface
        onPress={handleOpenClimb}
        disabled={!canOpenClimb}
        feedback="opacity"
        accessibilityRole="button"
        accessibilityLabel={t('mobile.home.sections.beta.openClimb', { climb: climbName })}
        hitSlop={6}
        style={styles.climbButton}
      >
        <Text variant="caption1" color={systemColors.label} numberOfLines={1}>
          {climbName}
        </Text>
      </PressableSurface>
    </View>
  );
});

function StateRow({
  icon,
  action,
  children,
}: {
  icon: 'offline.unavailable' | 'error' | 'video';
  action?: ReactNode;
  children: string;
}) {
  const { systemColors } = useTheme();
  return (
    <View style={[styles.stateRow, { borderColor: systemColors.separator }]}>
      <Icon name={icon} size={20} color={systemColors.secondaryLabel} />
      <Text variant="subheadline" color={systemColors.secondaryLabel} style={styles.stateText}>
        {children}
      </Text>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    paddingBottom: spacing[5],
  },
  body: {
    paddingTop: SHELF_HEADER_CONTENT_GAP,
  },
  listContent: {
    paddingHorizontal: LIST_INSET,
  },
  cardGap: {
    width: CARD_GAP,
  },
  card: {
    width: BETA_CARD_WIDTH,
    gap: spacing[1],
  },
  climbButton: {
    minHeight: 24,
    justifyContent: 'center',
  },
  skeletonRow: {
    flexDirection: 'row',
    gap: CARD_GAP,
    paddingHorizontal: spacing[4],
  },
  skeletonCard: {
    width: BETA_CARD_WIDTH,
    height: BETA_CARD_HEIGHT,
    borderRadius: borderRadius.md,
    opacity: 0.5,
  },
  stateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    marginHorizontal: spacing[4],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[3],
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  stateText: {
    flex: 1,
    minWidth: 0,
  },
});
