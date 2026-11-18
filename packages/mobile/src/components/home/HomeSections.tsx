import { memo } from 'react';
import { LiveSessionsRail } from '../live-sessions/LiveSessionsRail';
import type { HomeTopSectionId } from '../../lib/home-sections';
import { HomeBetaSection } from './HomeBetaSection';
import { HomeBoardSection } from './HomeBoardSection';
import { HomePlaylistsSection } from './HomePlaylistsSection';
import { HomeProjectsSection } from './HomeProjectsSection';
import { HomeSessionSection } from './HomeSessionSection';
import { HomeWeekSection } from './HomeWeekSection';

type HomeSectionsProps = {
  /** The switched-on sections above the feed, in the climber's order. */
  sectionIds: readonly HomeTopSectionId[];
  /**
   * False until Home is first focused. Every tab mounts at launch, and the cards
   * wait for that first visit, so launching on Climbs costs Home nothing.
   */
  cardsReady: boolean;
  /** Climbing now's scope: the selected board in gym mode, null in crew mode. */
  liveBoardUuid: string | null;
  /** False until Home's scope has settled, so a cold start fetches Climbing now and Fresh beta once. */
  liveEnabled: boolean;
  /** Fresh beta's board: Home's selected board, in either mode. Null is every board. */
  betaBoardType: string | null;
  betaLayoutId: number | null;
  onInvite: (sessionId: string) => void;
};

/**
 * Home's sections above the feed. Only the switched-on ones mount, so a hidden
 * section never starts its queries. Each one subscribes to its own data, so a
 * poll never rebuilds the list header around them.
 */
export const HomeSections = memo(function HomeSections({
  sectionIds,
  cardsReady,
  liveBoardUuid,
  liveEnabled,
  betaBoardType,
  betaLayoutId,
  onInvite,
}: HomeSectionsProps) {
  // The Session card offers Start, so Climbing now doesn't offer it a second time.
  const sessionCardShows = sectionIds.includes('session');
  return sectionIds.map((sectionId) => {
    switch (sectionId) {
      case 'week':
        return cardsReady ? <HomeWeekSection key={sectionId} /> : null;
      case 'board':
        return cardsReady ? <HomeBoardSection key={sectionId} /> : null;
      case 'session':
        return cardsReady ? <HomeSessionSection key={sectionId} /> : null;
      case 'projects':
        return cardsReady ? <HomeProjectsSection key={sectionId} /> : null;
      case 'playlists':
        return cardsReady ? <HomePlaylistsSection key={sectionId} /> : null;
      // The rail mounts as it always has and holds its own reads on `liveEnabled`.
      case 'climbingNow':
        return (
          <LiveSessionsRail
            key={sectionId}
            boardUuid={liveBoardUuid}
            enabled={liveEnabled}
            onInvite={onInvite}
            showStartPrompt={!sessionCardShows}
          />
        );
      case 'beta':
        return cardsReady ? (
          <HomeBetaSection key={sectionId} boardType={betaBoardType} layoutId={betaLayoutId} enabled={liveEnabled} />
        ) : null;
      default:
        // A new top section stops compiling here until it gets a case. At run
        // time it draws nothing.
        sectionId satisfies never;
        return null;
    }
  });
});
