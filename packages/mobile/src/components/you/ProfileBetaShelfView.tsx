import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { HorizontalScrollSection } from '../HorizontalScrollSection';
import { BETA_CARD_COMPACT_HEIGHT } from '../play-drawer/BetaVideoCardView';
export const ProfileBetaShelfView = memo(function ProfileBetaShelfView({
  count,
  isLoading,
  isLoadingMore,
  expanded,
  onToggle,
  onLoadMore,
  onSeeAll,
  children,
}: {
  count: number;
  isLoading: boolean;
  isLoadingMore: boolean;
  expanded: boolean;
  onToggle: () => void;
  onLoadMore: () => void;
  onSeeAll: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation('you');
  // Nothing to show and the first page has settled — keep the profile clean.
  if (!isLoading && count === 0) return null;

  const hasVideos = count > 0;

  return (
    <HorizontalScrollSection
      title={t('mobile.profile.betaShelf.title')}
      actionLabel={hasVideos ? t('mobile.profile.betaShelf.seeAll') : undefined}
      onActionPress={hasVideos ? onSeeAll : undefined}
      loading={isLoading && !hasVideos}
      isLoadingMore={isLoadingMore}
      onEndReached={onLoadMore}
      minHeight={BETA_CARD_COMPACT_HEIGHT}
      disclosure={{ expanded, onToggle: onToggle }}
    >
      {children}
    </HorizontalScrollSection>
  );
});
