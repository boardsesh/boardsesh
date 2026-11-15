import { betaLinkIdentity } from '@boardsesh/shared-schema';
import { memo, useCallback } from 'react';
import { useBetaShelfCollapse } from '../../lib/beta-shelf-collapse';
import { useUserBetaLinks } from '../../lib/graphql/hooks';
import { scopedRouter as router } from '../../lib/routing/scoped-navigation';
import { BetaVideoCard } from '../play-drawer/BetaVideoCard';
import { ProfileBetaShelfView } from './ProfileBetaShelfView';

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

  return (
    <ProfileBetaShelfView
      count={videos.length}
      isLoading={isLoading}
      isLoadingMore={isLoadingMore}
      expanded={expanded}
      onToggle={toggle}
      onLoadMore={loadMore}
      onSeeAll={handleSeeAll}
    >
      {videos.map((video) => (
        <BetaVideoCard key={betaLinkIdentity(video.betaLink.link)} link={video.betaLink} size="compact" />
      ))}
    </ProfileBetaShelfView>
  );
});
