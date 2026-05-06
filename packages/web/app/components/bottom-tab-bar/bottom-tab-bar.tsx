'use client';

import React, { useState, useCallback } from 'react';
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
import { track } from '@/app/lib/analytics';
import type { BoardDetails, BoardName, BoardRouteIdentity } from '@/app/lib/types';
import {
  constructClimbListWithSlugs,
  constructBoardSlugListUrl,
  tryConstructSlugListUrl,
  generateLayoutSlug,
  generateSizeSlug,
  generateSetSlug,
  searchParamsToUrlParams,
  getPlaylistsBasePath,
} from '@/app/lib/url-utils';
import { themeTokens } from '@/app/theme/theme-config';
import { useColorMode } from '@/app/hooks/use-color-mode';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import { usePersistentSessionState } from '../persistent-session';
import { getLastUsedBoard } from '@/app/lib/last-used-board-db';
import { getRecentSearches } from '@/app/components/search-drawer/recent-searches-storage';
import BoardDiscoveryScroll from '../board-scroll/board-discovery-scroll';
import BoardSelectorDrawer from '../board-selector-drawer/board-selector-drawer';
import type { BoardConfigData } from '@/app/lib/server-board-configs';
import { getDefaultAngleForBoard } from '@/app/lib/board-config-for-playlist';
import { useSession } from 'next-auth/react';
import type { UserBoard, PopularBoardConfig } from '@boardsesh/shared-schema';
import type { StoredBoardConfig } from '@/app/lib/saved-boards-db';
import { useBoardSwitchGuard } from '@/app/components/board-lock/use-board-switch-guard';

type Tab = 'home' | 'climbs' | 'library' | 'feed' | 'create' | 'you';

type BottomTabBarProps = {
  boardDetails?: BoardDetails | null;
  angle?: number;
  boardConfigs?: BoardConfigData;
};

const getActiveTab = (pathname: string): Tab => {
  if (pathname === '/') return 'home';
  if (pathname.endsWith('/create')) return 'create';
  if (pathname.startsWith('/feed')) return 'feed';
  if (pathname.startsWith('/you')) return 'you';
  if (pathname.startsWith('/discover/')) return 'library';
  if (pathname.startsWith('/playlists') || pathname.includes('/playlists')) return 'library';
  return 'climbs';
};

const listUrlToCreateUrl = (url: string): string => {
  const [path, query = ''] = url.split('?');
  if (!path.endsWith('/list')) return url;
  const createPath = `${path.slice(0, -5)}/create`;
  return query ? `${createPath}?${query}` : createPath;
};

const actionSx = {
  color: 'var(--neutral-400)',
  '&.Mui-selected': { color: themeTokens.colors.primary },
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
  const [isCreateClimbFlow, setIsCreateClimbFlow] = useState(false);

  // Stable callbacks for drawer unmount-after-close-animation pattern.
  // Avoids invalidating MUI's SlideProps memo on every parent render.
  const handleCustomBoardTransitionEnd = useCallback((open: boolean) => {
    if (!open) setIsCustomBoardRendered(false);
  }, []);
  const handleBoardSelectorTransitionEnd = useCallback((open: boolean) => {
    if (!open) setIsBoardSelectorRendered(false);
  }, []);

  const pathname = usePathnameWithoutLocale();
  const router = useLocaleRouter();
  const guardBoardSwitch = useBoardSwitchGuard();

  const { data: session, status: sessionStatus } = useSession();
  const isAuthenticated = sessionStatus === 'authenticated';

  // Use the active queue's board details as a fallback when no boardDetails prop
  const { activeSession, localBoardDetails, localCurrentClimbQueueItem } = usePersistentSessionState();

  // Resolve effective board details: prop > active session > local queue
  const effectiveBoardDetails =
    boardDetails ?? (activeSession ? activeSession.boardDetails : null) ?? localBoardDetails;
  const effectiveAngle =
    angle ??
    (activeSession ? activeSession.parsedParams.angle : undefined) ??
    localCurrentClimbQueueItem?.climb?.angle ??
    0;

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
    const { board_name, layout_name, size_name, size_description, set_names } = effectiveBoardDetails;
    if (layout_name && size_name && set_names) {
      return constructClimbListWithSlugs(
        board_name,
        layout_name,
        size_name,
        size_description,
        set_names,
        effectiveAngle,
      );
    }
    return null;
  })();

  const createClimbUrl = (() => {
    if (!effectiveBoardDetails) return null;
    const { board_name, layout_name, size_name, size_description, set_names } = effectiveBoardDetails;
    if (layout_name && size_name && set_names) {
      return `/${board_name}/${generateLayoutSlug(layout_name)}/${generateSizeSlug(size_name, size_description)}/${generateSetSlug(set_names)}/${effectiveAngle}/create`;
    }
    return null;
  })();

  const handleHomeTab = () => {
    router.push('/');
    track('Bottom Tab Bar', { tab: 'home' });
  };

  // Whether we're currently on a board page (URL derived from pathname is reliable)
  const isOnBoardPage =
    pathname.startsWith('/b/') ||
    (!!effectiveBoardDetails &&
      pathname !== '/' &&
      !pathname.startsWith('/profile') &&
      !pathname.startsWith('/you') &&
      !pathname.startsWith('/playlists') &&
      !pathname.startsWith('/notifications'));

  const handleClimbsTab = async () => {
    let url: string | null = null;

    if (isOnBoardPage) {
      // On a board page, use listUrl derived from the current pathname
      url = listUrl;
    } else {
      // Not on a board page: prefer the stored URL (preserves /b/ format)
      const lastUsed = await getLastUsedBoard();
      if (lastUsed?.url) {
        url = lastUsed.url;
      }
      // Fall back to computed listUrl from session board details
      if (!url) {
        url = listUrl;
      }
    }

    // Final fallback for isOnBoardPage case where listUrl is null
    if (!url) {
      const lastUsed = await getLastUsedBoard();
      url = lastUsed?.url ?? null;
    }

    // Open board selector drawer if no board context
    if (!url) {
      setIsBoardSelectorRendered(true);
      setIsBoardSelectorOpen(true);
      track('Bottom Tab Bar', { tab: 'climbs', action: 'open_selector' });
      return;
    }

    // Auto-apply most recent filter
    try {
      const recentSearches = await getRecentSearches();
      if (recentSearches.length > 0) {
        const mostRecent = recentSearches[0];
        const filterParams = searchParamsToUrlParams(
          mostRecent.filters as Parameters<typeof searchParamsToUrlParams>[0],
        );
        const filterString = filterParams.toString();
        if (filterString) {
          url = `${url}?${filterString}`;
        }
      }
    } catch {
      // Ignore errors loading recent searches
    }

    // Preserve active session param so BoardSessionBridge can re-activate the session
    if (activeSession?.sessionId && url) {
      const separator = url.includes('?') ? '&' : '?';
      url = `${url}${separator}session=${activeSession.sessionId}`;
    }

    const currentUrl = pathname + (typeof window !== 'undefined' ? window.location.search : '');
    if (url !== currentUrl) {
      router.push(url);
    }
    track('Bottom Tab Bar', { tab: 'climbs' });
  };

  const playlistsUrl = getPlaylistsBasePath(pathname);

  const handleLibraryTab = () => {
    const currentUrl = pathname + (typeof window !== 'undefined' ? window.location.search : '');
    if (playlistsUrl !== currentUrl) {
      router.push(playlistsUrl);
    }
    track('Bottom Tab Bar', { tab: 'library' });
  };

  const handleFeedTab = () => {
    router.push('/feed');
    track('Bottom Tab Bar', { tab: 'feed' });
  };

  const handleYouTab = () => {
    if (!isAuthenticated || !session?.user?.id) {
      openAuthModal({
        title: t('bottomTabBar.youSignInTitle'),
        description: t('bottomTabBar.youSignInDescription'),
        onSuccess: () => {
          router.push('/you');
        },
      });
      return;
    }
    router.push('/you');
    track('Bottom Tab Bar', { tab: 'you' });
  };

  const handleCreateTab = () => {
    track('Bottom Tab Bar', { tab: 'create' });
    // Go directly to create climb, skip the drawer
    if (createClimbUrl) {
      router.push(createClimbUrl);
      return;
    }
    if (boardConfigs) {
      setIsCreateClimbFlow(true);
      setIsBoardSelectorRendered(true);
      setIsBoardSelectorOpen(true);
    }
  };

  const handleTabChange = (_event: React.SyntheticEvent, newValue: Tab) => {
    switch (newValue) {
      case 'home':
        handleHomeTab();
        break;
      case 'climbs':
        void handleClimbsTab();
        break;
      case 'library':
        handleLibraryTab();
        break;
      case 'feed':
        handleFeedTab();
        break;
      case 'create':
        handleCreateTab();
        break;
      case 'you':
        handleYouTab();
        break;
    }
  };

  const handleBoardSelected = useCallback(
    (url: string, config?: StoredBoardConfig) => {
      if (isCreateClimbFlow) {
        router.push(listUrlToCreateUrl(url));
        setIsCreateClimbFlow(false);
        return;
      }

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
    [isCreateClimbFlow, router, guardBoardSwitch],
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
      let url: string;
      if (config.layoutName && config.sizeName && config.setNames.length > 0) {
        url = constructClimbListWithSlugs(
          config.boardType,
          config.layoutName,
          config.sizeName,
          config.sizeDescription ?? undefined,
          config.setNames,
          angle,
        );
      } else {
        const setIds = config.setIds.join(',');
        url =
          tryConstructSlugListUrl(config.boardType, config.layoutId, config.sizeId, config.setIds, angle) ??
          `/${config.boardType}/${config.layoutId}/${config.sizeId}/${setIds}/${angle}/list`;
      }
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
        onChange={handleTabChange}
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
          sx={actionSx}
        />
        <BottomNavigationAction
          label={t('bottomTabBar.climb')}
          icon={<FormatListBulletedOutlined sx={{ fontSize: 20 }} />}
          value="climbs"
          sx={actionSx}
        />
        <BottomNavigationAction
          label={t('bottomTabBar.discover')}
          icon={<LocalOfferOutlined sx={{ fontSize: 20 }} />}
          value="library"
          sx={actionSx}
        />
        <BottomNavigationAction
          label={t('bottomTabBar.feed')}
          icon={<DynamicFeedOutlined sx={{ fontSize: 20 }} />}
          value="feed"
          sx={actionSx}
        />
        <BottomNavigationAction
          label={t('bottomTabBar.create')}
          icon={<AddOutlined sx={{ fontSize: 20 }} />}
          value="create"
          sx={actionSx}
        />
        <BottomNavigationAction
          label={t('bottomTabBar.you')}
          icon={<PersonOutlined sx={{ fontSize: 20 }} />}
          value="you"
          sx={actionSx}
        />
      </BottomNavigation>

      {/* Board Selector Drawer */}
      {isBoardSelectorRendered && (
        <SwipeableDrawer
          title={t('common:boardSelector.title')}
          placement="bottom"
          open={isBoardSelectorOpen}
          onClose={() => {
            setIsBoardSelectorOpen(false);
            setIsCreateClimbFlow(false);
          }}
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
