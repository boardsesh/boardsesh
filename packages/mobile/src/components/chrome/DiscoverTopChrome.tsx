import { useTranslation } from 'react-i18next';
import type { ScrollEdgeBackdrop } from '../../hooks/use-scroll-edge-backdrop';
import { CollapsingTopChrome } from './CollapsingTopChrome';

type DiscoverTopChromeProps = {
  /** Gate the create + (an authed user with a board can build a playlist). */
  canCreate: boolean;
  /** Build a playlist (Discover's defining action — no separate FAB). */
  onCreate: () => void;
  /** Open the full board switcher; the pill doubles as the board filter. */
  onOpenBoardSwitcher: () => void;
  /** Report the measured chrome height so the list can inset its top padding. */
  onHeightChange: (height: number) => void;
  /** The scrolling shelves, so the Material app bar tints once they pass under it. */
  scrollEdge?: ScrollEdgeBackdrop;
};

/**
 * Discover's floating glass chrome. A thin wrapper over the shared
 * `CollapsingTopChrome` that injects the playlist / boards i18n strings. The
 * board pill + islands stay put over the progressive blur; the in-body "Discover"
 * title scrolls away (the tab bar already labels the tab, so no scrolled title).
 * Material has no in-body title: "Discover" is the app bar's title instead.
 */
export function DiscoverTopChrome(props: DiscoverTopChromeProps) {
  const { t } = useTranslation('playlists');
  const { t: tBoards } = useTranslation('boards');
  return (
    <CollapsingTopChrome
      {...props}
      materialTitle={t('bottomTabBar.discover')}
      createAccessibilityLabel={t('library.createFab.ariaLabel')}
      boardPillAccessibilityHint={tBoards('boardPill.switchHint')}
    />
  );
}
