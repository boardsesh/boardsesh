'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import BottomNavigation from '@mui/material/BottomNavigation';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import HomeOutlined from '@mui/icons-material/HomeOutlined';
import FormatListBulletedOutlined from '@mui/icons-material/FormatListBulletedOutlined';
import AddOutlined from '@mui/icons-material/AddOutlined';
import LocalOfferOutlined from '@mui/icons-material/LocalOfferOutlined';
import DynamicFeedOutlined from '@mui/icons-material/DynamicFeedOutlined';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import { useLocaleRouter, usePathnameWithoutLocale } from '@/app/lib/i18n/use-locale-router';
import type { BoardDetails, BoardName, BoardRouteIdentity } from '@/app/lib/types';
import {
  constructClimbListWithSlugs,
  constructBoardSlugListUrl,
  tryConstructSlugListUrl,
  popularConfigListUrl,
  getPlaylistsBasePath,
} from '@/app/lib/url-utils';
import { buildAppCreateClimbUrl } from '@/app/lib/app-handoff';
import { themeTokens } from '@/app/theme/theme-config';
import { useColorMode } from '@/app/hooks/use-color-mode';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import { usePersistentSessionState } from '../persistent-session';
import { getLastUsedBoard } from '@/app/lib/last-used-board-db';
import LocaleLink from '@/app/components/i18n/locale-link';
import BoardDiscoveryScroll from '../board-scroll/board-discovery-scroll';
import BoardSelectorDrawer from '../board-selector-drawer/board-selector-drawer';
import type { BoardConfigData } from '@/app/lib/server-board-configs';
import { getDefaultAngleForBoard } from '@/app/lib/board-config-for-playlist';
import { useSession } from 'next-auth/react';
import type { UserBoard, PopularBoardConfig } from '@boardsesh/shared-schema';
import type { StoredBoardConfig } from '@/app/lib/saved-boards-db';
import { useBoardSwitchGuard } from '@/app/components/board-lock/use-board-switch-guard';
import { BOARD_PRESENCE_SWITCH_BOARD_EVENT } from '../board-presence/board-presence-events';

type Tab = 'home' | 'climbs' | 'library' | 'feed' | 'you';

type BottomTabBarProps = {
  boardDetails?: BoardDetails | null;
  angle?: number;
  boardConfigs?: BoardConfigData;
};

/**
 * The Create tab is absent on purpose: it leaves www for the app, so no www
 * pathname ever belongs to it and it never renders selected.
 */
const getActiveTab = (pathname: string): Tab => {
  if (pathname === '/') return 'home';
  if (pathname.startsWith('/feed')) return 'feed';
  if (pathname.startsWith('/you')) return 'you';
  if (pathname.startsWith('/discover/')) return 'library';
  if (pathname.startsWith('/playlists') || pathname.includes('/playlists')) return 'library';
  return 'climbs';
};

const actionSx = {
  color: 'var(--neutral-400)',
  '&.Mui-selected': { color: 'var(--color-primary)' },
  WebkitTapHighlightColor: 'transparent',
  touchAction: 'manipulation',
  minWidth: 'auto',
};

function BottomTabBar({ boardDetails, angle, boardConfigs }: BottomTabBarProps) {
  const { t } = useTranslation('playlists');
  const { mode } = useColorMode();
  const isDark = mode === 'dark';
  const { openAuthModal } = useAuthModal();
  const [isBoardSelectorOpen, setIsBoardSelectorOpen] = useState(false);
  const [isBoardSelectorRendered, setIsBoardSelectorRendered] = useState(false);
  const [isCustomBoardOpen, setIsCustomBoardOpen] = useState(false);
  const [isCustomBoardRendered, setIsCustomBoardRendered] = useState(false);

  // Stable callbacks for drawer unmount-after-close-animation pattern.
  // Avoids invalidating MUI's SlideProps memo on every parent render.
  const handleCustomBoardTransitionEnd = useCallback((open: boolean) => {
    if (!open) setIsCustomBoardRendered(false);
  }, []);
  const handleBoardSelectorTransitionEnd = useCallback((open: boolean) => {
    if (!open) setIsBoardSelectorRendered(false);
  }, []);

  // The board-presence sheet's separated "Switch board" control dispatches a
  // window event (instead of plumbing boardConfigs into the presence tree);
  // open the existing custom board selector here. No-op when the flag is off —
  // the sheet that fires the event only renders behind the board-presence flag.
  useEffect(() => {
    const handler = () => {
      setIsCustomBoardRendered(true);
      setIsCustomBoardOpen(true);
    };
    window.addEventListener(BOARD_PRESENCE_SWITCH_BOARD_EVENT, handler);
    return () => window.removeEventListener(BOARD_PRESENCE_SWITCH_BOARD_EVENT, handler);
  }, []);

  const pathname = usePathnameWithoutLocale();
  const router = useLocaleRouter();
  const guardBoardSwitch = useBoardSwitchGuard();

  const { data: session, status: sessionStatus } = useSession();
  const isAuthenticated = sessionStatus === 'authenticated';

  // Use the active queue's board details as a fallback when no boardDetails prop
  const { activeSession, soloBoardDetails, currentClimbQueueItem } = usePersistentSessionState();

  // Resolve effective board details: prop > active session > solo board context
  const effectiveBoardDetails = boardDetails ?? (activeSession ? activeSession.boardDetails : null) ?? soloBoardDetails;
  const effectiveAngle =
    angle ?? (activeSession ? activeSession.parsedParams.angle : undefined) ?? currentClimbQueueItem?.climb?.angle ?? 0;

  // Determine active tab from pathname
  const activeTab = getActiveTab(pathname);

  // Build URLs using effective board details
  // If we're on a /b/ slug route, preserve the slug URL format
  const listUrl = (() => {
    if (pathname.startsWith('/b/')) {
      const segments = pathname.split('/');
      // /b/{slug}/{angle}/... → /b/{slug}/{angle}/list
      if (segments.length >= 4) {
        return `/b/${segments[2]}/${segments[3]}/list`;
      }
    }
    // Fallback: use active session's board path if it's a /b/ slug route
    if (activeSession?.boardPath?.startsWith('/b/')) {
      const segments = activeSession.boardPath.split('/');
      if (segments.length >= 4) {
        return `/b/${segments[2]}/${segments[3]}/list`;
      }
    }
    if (!effectiveBoardDetails) return null;
    const { board_name, layout_id, size_id, set_ids, layout_name, size_name, size_description, set_names } =
      effectiveBoardDetails;
    if (layout_name && size_name && set_names) {
      // Id-aware first: the name-based builder only knows the bare size slug, so
      // on a size that shares one with another on the same layout (Kilter layout
      // 1 sizes 10/27) the Climbs tab would open the other board. Names stay as
      // the fallback for a board the static tables don't carry.
      return (
        tryConstructSlugListUrl(board_name, layout_id, size_id, set_ids, effectiveAngle) ??
        constructClimbListWithSlugs(board_name, layout_name, size_name, size_description, set_names, effectiveAngle)
      );
    }
    return null;
  })();

  // The climb editor lives in the app — W-17 (#4433) deleted www's own
  // `…/[angle]/create` routes. This is a real cross-origin <a> rather than a
  // link into a route that would 307 straight back off the site, and the board
  // in scope rides along so the editor opens on the wall the reader is looking
  // at. With no board in scope it hands over bare and the app falls back to the
  // signed-in user's active board.
  const createClimbHref = buildAppCreateClimbUrl(
    effectiveBoardDetails
      ? {
          boardName: effectiveBoardDetails.board_name,
          layoutId: effectiveBoardDetails.layout_id,
          sizeId: effectiveBoardDetails.size_id,
          setIds: effectiveBoardDetails.set_ids,
          angle: effectiveAngle,
        }
      : null,
  );

  const playlistsUrl = getPlaylistsBasePath(pathname);

  // Synchronous climbs href: prefer the slug URL when board context is known,
  // append the active session param so BoardSessionBridge can re-activate it.
  // When listUrl is null (no board context), we fall back to an async handler
  // that consults IndexedDB for the last-used board.
  const climbsHref = (() => {
    if (!listUrl) return null;
    if (activeSession?.sessionId) {
      const separator = listUrl.includes('?') ? '&' : '?';
      return `${listUrl}${separator}session=${activeSession.sessionId}`;
    }
    return listUrl;
  })();

  // Fallback async handler when no static href is available for the climbs tab.
  const handleClimbsFallback = useCallback(async () => {
    const lastUsed = await getLastUsedBoard();
    if (lastUsed?.url) {
      let url = lastUsed.url;
      if (activeSession?.sessionId) {
        const separator = url.includes('?') ? '&' : '?';
        url = `${url}${separator}session=${activeSession.sessionId}`;
      }
      router.push(url);
      return;
    }
    setIsBoardSelectorRendered(true);
    setIsBoardSelectorOpen(true);
  }, [activeSession?.sessionId, router]);

  const handleBoardSelected = useCallback(
    (url: string, config?: StoredBoardConfig) => {
      if (config) {
        const target: BoardRouteIdentity = {
          board_name: config.board,
          layout_id: config.layoutId,
          size_id: config.sizeId,
          set_ids: config.setIds,
        };
        guardBoardSwitch(target, () => router.push(url));
      } else {
        router.push(url);
      }
    },
    [router, guardBoardSwitch],
  );

  const handleDiscoveryBoardClick = useCallback(
    (board: UserBoard) => {
      if (board.slug) {
        const url = constructBoardSlugListUrl(board.slug, board.angle);
        const config: StoredBoardConfig = {
          name: board.name,
          board: board.boardType as BoardName,
          layoutId: board.layoutId,
          sizeId: board.sizeId,
          setIds: board.setIds.split(',').map(Number),
          angle: board.angle,
          createdAt: board.createdAt,
        };
        handleBoardSelected(url, config);
      }
      setIsBoardSelectorOpen(false);
    },
    [handleBoardSelected],
  );

  const handleDiscoveryConfigClick = useCallback(
    (config: PopularBoardConfig) => {
      const angle = getDefaultAngleForBoard(config.boardType);
      const url = popularConfigListUrl(config, angle);
      const storedConfig: StoredBoardConfig = {
        name: config.layoutName ?? `${config.boardType} board`,
        board: config.boardType as BoardName,
        layoutId: config.layoutId,
        sizeId: config.sizeId,
        setIds: config.setIds,
        angle,
        createdAt: new Date().toISOString(),
      };
      handleBoardSelected(url, storedConfig);
      setIsBoardSelectorOpen(false);
    },
    [handleBoardSelected],
  );

  return (
    <>
      <BottomNavigation
        data-testid="bottom-tab-bar"
        value={activeTab}
        // Each action is its own <Link>/onClick — onChange would just bounce
        // duplicate work. MUI still wants the prop wired on a controlled bar,
        // so pass a no-op to silence the controlled-without-onChange warning.
        onChange={() => {}}
        showLabels
        sx={{
          background: isDark ? 'rgba(26, 26, 26, 0.7)' : 'rgba(255, 255, 255, 0.3)',
          WebkitBackdropFilter: isDark ? 'blur(20px)' : 'blur(5px)',
          backdropFilter: isDark ? 'blur(20px)' : 'blur(5px)',
          borderRadius: `var(--tab-bar-top-radius, ${themeTokens.borderRadius.xl}px) var(--tab-bar-top-radius, ${themeTokens.borderRadius.xl}px) var(--tab-bar-bottom-radius, ${themeTokens.borderRadius.xl}px) var(--tab-bar-bottom-radius, ${themeTokens.borderRadius.xl}px)`,
          pt: `${themeTokens.spacing[2]}px`,
          pb: `calc(${themeTokens.spacing[2]}px + var(--tab-bar-safe-area-padding, 0px))`,
          mb: 'var(--tab-bar-bottom-extension, 0px)',
          height: 'auto',
          '@media (min-width: 768px)': {
            maxWidth: 480,
            mx: 'auto',
            boxShadow: themeTokens.shadows.lg,
            border: `1px solid var(--neutral-200)`,
          },
        }}
      >
        <BottomNavigationAction
          label={t('bottomTabBar.home')}
          icon={<HomeOutlined sx={{ fontSize: 20 }} />}
          value="home"
          component={LocaleLink}
          href="/"
          sx={actionSx}
        />
        {climbsHref ? (
          <BottomNavigationAction
            label={t('bottomTabBar.climb')}
            icon={<FormatListBulletedOutlined sx={{ fontSize: 20 }} />}
            value="climbs"
            component={LocaleLink}
            href={climbsHref}
            sx={actionSx}
          />
        ) : (
          <BottomNavigationAction
            label={t('bottomTabBar.climb')}
            icon={<FormatListBulletedOutlined sx={{ fontSize: 20 }} />}
            value="climbs"
            onClick={() => {
              void handleClimbsFallback();
            }}
            sx={actionSx}
          />
        )}
        <BottomNavigationAction
          label={t('bottomTabBar.discover')}
          icon={<LocalOfferOutlined sx={{ fontSize: 20 }} />}
          value="library"
          component={LocaleLink}
          href={playlistsUrl}
          sx={actionSx}
        />
        <BottomNavigationAction
          label={t('bottomTabBar.feed')}
          icon={<DynamicFeedOutlined sx={{ fontSize: 20 }} />}
          value="feed"
          component={LocaleLink}
          href="/feed"
          sx={actionSx}
        />
        {/* Cross-origin: a plain <a>, not LocaleLink — the app has no /es, /fr
            or /de routing and Next's client router doesn't own this hop. */}
        <BottomNavigationAction
          label={t('bottomTabBar.create')}
          icon={<AddOutlined sx={{ fontSize: 20 }} />}
          value="create"
          component="a"
          href={createClimbHref}
          sx={actionSx}
        />
        <BottomNavigationAction
          label={t('bottomTabBar.you')}
          icon={<PersonOutlined sx={{ fontSize: 20 }} />}
          value="you"
          component={LocaleLink}
          href="/you"
          onClick={(event: React.MouseEvent<HTMLAnchorElement>) => {
            // During the session-loading window we don't yet know whether the
            // user is signed in. Let Next.js navigate to /you; the layout
            // resolves auth on the server and redirects to / if needed.
            if (sessionStatus !== 'loading' && (!isAuthenticated || !session?.user?.id)) {
              event.preventDefault();
              openAuthModal({
                title: t('bottomTabBar.youSignInTitle'),
                description: t('bottomTabBar.youSignInDescription'),
                onSuccess: () => {
                  router.push('/you');
                },
              });
              return;
            }
          }}
          sx={actionSx}
        />
      </BottomNavigation>

      {/* Board Selector Drawer */}
      {isBoardSelectorRendered && (
        <SwipeableDrawer
          title={t('common:boardSelector.title')}
          placement="bottom"
          open={isBoardSelectorOpen}
          onClose={() => setIsBoardSelectorOpen(false)}
          onTransitionEnd={handleBoardSelectorTransitionEnd}
        >
          <BoardDiscoveryScroll
            onBoardClick={handleDiscoveryBoardClick}
            onConfigClick={handleDiscoveryConfigClick}
            onCustomClick={() => {
              setIsBoardSelectorOpen(false);
              setIsCustomBoardRendered(true);
              setIsCustomBoardOpen(true);
            }}
          />
        </SwipeableDrawer>
      )}

      {/* Custom Board Selector Drawer */}
      {boardConfigs && isCustomBoardRendered && (
        <BoardSelectorDrawer
          open={isCustomBoardOpen}
          onClose={() => setIsCustomBoardOpen(false)}
          onTransitionEnd={handleCustomBoardTransitionEnd}
          boardConfigs={boardConfigs}
          placement="bottom"
          onBoardSelected={(url) => {
            handleBoardSelected(url);
            setIsCustomBoardOpen(false);
          }}
        />
      )}
    </>
  );
}

export default BottomTabBar;
