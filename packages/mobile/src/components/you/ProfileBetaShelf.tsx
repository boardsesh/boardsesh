import { memo, useCallback } from 'react';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { betaLinkIdentity } from '@boardsesh/shared-schema';
import { HorizontalScrollSection } from '../HorizontalScrollSection';
import { BetaVideoCard, BETA_CARD_COMPACT_HEIGHT } from '../play-drawer/BetaVideoCard';
import { useUserBetaLinks } from '../../lib/graphql/hooks';

type ProfileBetaShelfProps = {
  /** The climber whose beta videos to show (own id on the You tab). */
  userId: string;
};

/**
 * Horizontal shelf of a climber's recent beta videos for the profile page,
 * with infinite scroll and a "See all" link to the full grid. Reuses the
 * Discover playlist slider (`HorizontalScrollSection`) and the beta card.
 * Renders nothing for climbers with no beta so it never wastes profile space.
 */
export const ProfileBetaShelf = memo(function ProfileBetaShelf({ userId }: ProfileBetaShelfProps) {
  const { t } = useTranslation('you');
  const { videos, isLoading, isLoadingMore, loadMore } = useUserBetaLinks(userId);

  const handleSeeAll = useCallback(() => {
    router.push({ pathname: '/users/[userId]/beta', params: { userId } });
  }, [userId]);

  // Nothing to show and the first page has settled — keep the profile clean.
  if (!isLoading && videos.length === 0) return null;

  const hasVideos = videos.length > 0;

  return (
    <HorizontalScrollSection
      title={t('mobile.profile.betaShelf.title')}
      actionLabel={hasVideos ? t('mobile.profile.betaShelf.seeAll') : undefined}
      onActionPress={hasVideos ? handleSeeAll : undefined}
      loading={isLoading && !hasVideos}
      isLoadingMore={isLoadingMore}
      onEndReached={loadMore}
      minHeight={BETA_CARD_COMPACT_HEIGHT}
    >
      {videos.map((video) => (
        <BetaVideoCard key={betaLinkIdentity(video.betaLink.link)} link={video.betaLink} size="compact" />
      ))}
    </HorizontalScrollSection>
  );
});
