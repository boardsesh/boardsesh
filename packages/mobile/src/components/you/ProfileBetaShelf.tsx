import { memo, useCallback } from 'react';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { betaLinkIdentity } from '@boardsesh/shared-schema';
import { HorizontalScrollSection } from '../HorizontalScrollSection';
import { BetaVideoCard, BETA_CARD_COMPACT_HEIGHT } from '../play-drawer/BetaVideoCard';
import { useUserBetaLinks } from '../../lib/graphql/hooks';
import { useBetaShelfCollapse } from '../../lib/beta-shelf-collapse';

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
  // Deliberately not gated on `expanded`: this shelf hides itself entirely when
  // the climber has no beta, so skipping the query while collapsed would strip
  // the header too and leave no way to unfold it again. That protection leans on
  // the empty-state guard below staying keyed to *real* results — if
  // `useUserBetaLinks` ever returns placeholder rows while loading, revisit both
  // together. Covered by `__tests__/profile-beta-shelf-collapse.test.tsx`.
  const { videos, isLoading, isLoadingMore, loadMore } = useUserBetaLinks(userId);
  const { expanded, toggle } = useBetaShelfCollapse();

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
      disclosure={{ expanded, onToggle: toggle }}
    >
      {videos.map((video) => (
        <BetaVideoCard key={betaLinkIdentity(video.betaLink.link)} link={video.betaLink} size="compact" />
      ))}
    </HorizontalScrollSection>
  );
});
