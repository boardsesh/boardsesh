import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { PlaylistScrollSection } from '../playlist';
import { BetaVideoCard } from '../play-drawer/BetaVideoCard';
import { betaLinkIdentity } from '../../lib/beta-video-url';
import { useHomeBetaLinks } from '../../lib/home/use-home-beta-links';

export type HomeBetaRowProps = {
  boardType: string;
  layoutId: number;
};

/**
 * Recent community beta videos for the active board's layout. Hidden entirely
 * when the layout has no recent beta — board-filtered recency is thin, and beta
 * as a discovery feed is low-signal, so it stays a quiet freshness row.
 */
export const HomeBetaRow = memo(function HomeBetaRow({ boardType, layoutId }: HomeBetaRowProps) {
  const { t } = useTranslation('playlists');
  const { data: betaLinks = [], isLoading } = useHomeBetaLinks(boardType, layoutId);

  if (!isLoading && betaLinks.length === 0) return null;

  return (
    <PlaylistScrollSection title={t('home.beta')} loading={isLoading && betaLinks.length === 0}>
      {betaLinks.map((link) => (
        <BetaVideoCard key={betaLinkIdentity(link.link)} link={link} />
      ))}
    </PlaylistScrollSection>
  );
});
