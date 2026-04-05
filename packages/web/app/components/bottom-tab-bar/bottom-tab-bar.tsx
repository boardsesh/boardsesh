'use client';

import React, { useState, useCallback, useContext } from 'react';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import MuiButton from '@mui/material/Button';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import BottomNavigation from '@mui/material/BottomNavigation';
import BottomNavigationAction from '@mui/material/BottomNavigationAction';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import HomeOutlined from '@mui/icons-material/HomeOutlined';
import FormatListBulletedOutlined from '@mui/icons-material/FormatListBulletedOutlined';
import AddOutlined from '@mui/icons-material/AddOutlined';
import LocalOfferOutlined from '@mui/icons-material/LocalOfferOutlined';
import DynamicFeedOutlined from '@mui/icons-material/DynamicFeedOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import NotificationsOutlined from '@mui/icons-material/NotificationsOutlined';
import Badge from '@mui/material/Badge';
import { usePathname, useRouter } from 'next/navigation';
import { track } from '@vercel/analytics';
import { BoardDetails } from '@/app/lib/types';
import { constructClimbListWithSlugs, generateLayoutSlug, generateSizeSlug, generateSetSlug, searchParamsToUrlParams, getContextAwarePlaylistUrl, getPlaylistsBasePath } from '@/app/lib/url-utils';
import { themeTokens } from '@/app/theme/theme-config';
import { useColorMode } from '@/app/hooks/use-color-mode';
import { PlaylistsContext } from '../climb-actions/playlists-batch-context';
import AuthModal from '../auth/auth-modal';
import { usePersistentSession } from '../persistent-session';
import { getLastUsedBoard } from '@/app/lib/last-used-board-db';
import { getRecentSearches } from '@/app/components/search-drawer/recent-searches-storage';
import BoardSelectorDrawer from '../board-selector-drawer/board-selector-drawer';
import { BoardConfigData } from '@/app/lib/server-board-configs';
import { useUnreadNotificationCount } from '@/app/hooks/use-unread-notification-count';
import { useClimbActionsData } from '@/app/hooks/use-climb-actions-data';
import type { StoredBoardConfig } from '@/app/lib/saved-boards-db';
import { isValidHexColor } from '@/app/lib/color-utils';
import { getPlatform } from '@/app/lib/ble/capacitor-utils';

type Tab = 'home' | 'climbs' | 'library' | 'feed' | 'create' | 'notifications';
type PendingCreateAction = 'climb' | 'playlist' | null;

interface BottomTabBarProps {
  boardDetails?: BoardDetails | null;
  angle?: number;
  boardConfigs?: BoardConfigData;
}

interface SelectedBoardContext {
  boardName: string;
  layoutId: number;
  angle: number;
}

const getActiveTab = (pathname: string): Tab => {
  if (pathname === '/') return 'home';
  if (pathname.startsWith('/feed')) return 'feed';
  if (pathname.startsWith('/notifications')) return 'notifications';
  if (pathname.startsWith('/playlists') || pathname.includes('/playlists')) return 'library';
  return 'climbs';
};

const INITIAL_PLAYLIST_FORM = { name: '', description: '', color: '' };

const getBoardContextFromSelector = (config?: StoredBoardConfig): SelectedBoardContext | null => {
  if (!config || typeof config.layoutId !== 'number' || config.layoutId <= 0) {
    return null;
  }
  return {
    boardName: config.board,
    layoutId: config.layoutId,
    angle: config.angle ?? 40,
  };
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
  const { mode } = useColorMode();
  const isDark = mode === 'dark';
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isCreatePlaylistOpen, setIsCreatePlaylistOpen] = useState(false);
  const [isCreatingPlaylist, setIsCreatingPlaylist] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [isBoardSelectorOpen, setIsBoardSelectorOpen] = useState(false);
  const [pendingCreateAction, setPendingCreateAction] = useState<PendingCreateAction>(null);
  const [selectedBoardContext, setSelectedBoardContext] = useState<SelectedBoardContext | null>(null);
  const [playlistFormValues, setPlaylistFormValues] = useState(INITIAL_PLAYLIST_FORM);
  const [playlistFormErrors, setPlaylistFormErrors] = useState<Record<string, string>>({});
  const pathname = usePathname();
  const router = useRouter();

  const notificationUnreadCount = useUnreadNotificationCount();

  // Playlist context may be absent at root-level routes; use a local fallback for create flow.
  const playlistsContext = useContext(PlaylistsContext);
  const { showMessage } = useSnackbar();

  // Use the active queue's board details as a fallback when no boardDetails prop
  const {
    activeSession,
    localBoardDetails,
    localCurrentClimbQueueItem,
  } = usePersistentSession();

  // Resolve effective board details: prop > active session > local queue
  const effectiveBoardDetails = boardDetails
    ?? (activeSession ? activeSession.boardDetails : null)
    ?? localBoardDetails;
  const effectiveAngle = angle
    ?? (activeSession ? activeSession.parsedParams.angle : undefined)
    ?? localCurrentClimbQueueItem?.climb?.angle
    ?? 0;
  const playlistBoardName = effectiveBoardDetails?.board_name ?? selectedBoardContext?.boardName ?? '';
  const playlistLayoutId = effectiveBoardDetails?.layout_id ?? selectedBoardContext?.layoutId ?? 0;
  const playlistAngle = effectiveAngle ?? selectedBoardContext?.angle ?? 0;

  const { playlistsProviderProps } = useClimbActionsData({
    boardName: playlistBoardName,
    layoutId: playlistLayoutId,
    angle: playlistAngle,
    climbUuids: [],
  });
  const createPlaylist = playlistsContext?.createPlaylist ?? playlistsProviderProps.createPlaylist;
  const isAuthenticated = playlistsContext?.isAuthenticated ?? playlistsProviderProps.isAuthenticated;
  const canCreatePlaylistHere = !!playlistBoardName && playlistLayoutId > 0;

  // Hide playlists for moonboard (not yet supported)
  const isMoonboard = playlistBoardName === 'moonboard';

  // Hide feed tab in iOS native app (pending block/report functionality for app store compliance)
  const isIOSNativeApp = getPlatform() === 'ios';

  // Determine active tab from pathname
  const activeTabFromPath = getActiveTab(pathname);
  const activeTab = (isCreateOpen || isCreatePlaylistOpen) ? 'create' : activeTabFromPath;

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
      return constructClimbListWithSlugs(board_name, layout_name, size_name, size_description, set_names, effectiveAngle);
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

  const getPlaylistUrl = useCallback((playlistUuid: string) => {
    return getContextAwarePlaylistUrl(pathname, playlistUuid);
  }, [pathname]);

  const handleHomeTab = () => {
    setIsCreateOpen(false);
    setIsCreatePlaylistOpen(false);
    router.push('/');
    track('Bottom Tab Bar', { tab: 'home' });
  };

  // Whether we're currently on a board page (URL derived from pathname is reliable)
  const isOnBoardPage = pathname.startsWith('/b/') || (!!effectiveBoardDetails && pathname !== '/' && !pathname.startsWith('/notifications') && !pathname.startsWith('/playlists'));

  const handleClimbsTab = async () => {
    setIsCreateOpen(false);
    setIsCreatePlaylistOpen(false);

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
      if (boardConfigs) {
        setIsBoardSelectorOpen(true);
      }
      track('Bottom Tab Bar', { tab: 'climbs', action: 'open_selector' });
      return;
    }

    // Auto-apply most recent filter
    try {
      const recentSearches = await getRecentSearches();
      if (recentSearches.length > 0) {
        const mostRecent = recentSearches[0];
        const filterParams = searchParamsToUrlParams(mostRecent.filters as Parameters<typeof searchParamsToUrlParams>[0]);
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
    setIsCreateOpen(false);
    setIsCreatePlaylistOpen(false);
    const currentUrl = pathname + (typeof window !== 'undefined' ? window.location.search : '');
    if (playlistsUrl !== currentUrl) {
      router.push(playlistsUrl);
    }
    track('Bottom Tab Bar', { tab: 'library' });
  };

  const handleFeedTab = () => {
    setIsCreateOpen(false);
    setIsCreatePlaylistOpen(false);
    router.push('/feed');
    track('Bottom Tab Bar', { tab: 'feed' });
  };

  const handleNotificationsTab = () => {
    setIsCreateOpen(false);
    setIsCreatePlaylistOpen(false);
    router.push('/notifications');
    track('Bottom Tab Bar', { tab: 'notifications' });
  };

  const handleCreateTab = () => {
    setIsCreatePlaylistOpen(false);
    setIsCreateOpen(true);
    track('Bottom Tab Bar', { tab: 'create' });
  };

  const handleTabChange = (_event: React.SyntheticEvent, newValue: Tab) => {
    switch (newValue) {
      case 'home':
        handleHomeTab();
        break;
      case 'climbs':
        handleClimbsTab();
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
      case 'notifications':
        handleNotificationsTab();
        break;
    }
  };

  const handleOpenCreateClimb = () => {
    setIsCreateOpen(false);
    if (createClimbUrl) {
      router.push(createClimbUrl);
      return;
    }

    if (boardConfigs) {
      setPendingCreateAction('climb');
      setIsBoardSelectorOpen(true);
    }
  };

  const handleOpenCreatePlaylist = () => {
    if (!isAuthenticated) {
      setShowAuthModal(true);
      return;
    }

    if (!canCreatePlaylistHere) {
      setIsCreateOpen(false);
      if (boardConfigs) {
        setPendingCreateAction('playlist');
        setIsBoardSelectorOpen(true);
      } else {
        showMessage('Select a board before creating a playlist', 'error');
      }
      return;
    }

    setIsCreateOpen(false);
    setIsCreatePlaylistOpen(true);
  };

  const handleBoardSelected = useCallback((url: string, config?: StoredBoardConfig) => {
    const selectedContext = getBoardContextFromSelector(config);
    if (selectedContext) {
      setSelectedBoardContext(selectedContext);
    }

    if (pendingCreateAction === 'climb') {
      router.push(listUrlToCreateUrl(url));
      setPendingCreateAction(null);
      return;
    }

    if (pendingCreateAction === 'playlist') {
      if (!selectedContext) {
        showMessage('Unable to determine board details for playlist creation', 'error');
        setPendingCreateAction(null);
        return;
      }
      setIsCreatePlaylistOpen(true);
      setPendingCreateAction(null);
      return;
    }

    router.push(url);
  }, [pendingCreateAction, router, showMessage]);

  const validatePlaylistForm = useCallback((): boolean => {
    const errors: Record<string, string> = {};
    if (!playlistFormValues.name.trim()) {
      errors.name = 'Please enter a playlist name';
    } else if (playlistFormValues.name.length > 100) {
      errors.name = 'Name too long';
    }
    if (playlistFormValues.description.length > 500) {
      errors.description = 'Description too long';
    }
    setPlaylistFormErrors(errors);
    return Object.keys(errors).length === 0;
  }, [playlistFormValues]);

  const handleCreatePlaylist = useCallback(async () => {
    if (!validatePlaylistForm() || !createPlaylist) {
      return;
    }

    if (!canCreatePlaylistHere) {
      showMessage('Select a board before creating a playlist', 'error');
      return;
    }

    try {
      setIsCreatingPlaylist(true);

      // Extract and validate hex color
      let colorHex: string | undefined;
      if (playlistFormValues.color && isValidHexColor(playlistFormValues.color)) {
        colorHex = playlistFormValues.color;
      }

      const newPlaylist = await createPlaylist(playlistFormValues.name, playlistFormValues.description, colorHex, undefined);

      showMessage(`Created playlist "${playlistFormValues.name}"`, 'success');
      track('Create Playlist', {
        boardName: playlistBoardName || 'unknown',
        playlistName: playlistFormValues.name,
        source: 'bottom-tab-bar',
      });

      setPlaylistFormValues(INITIAL_PLAYLIST_FORM);
      setPlaylistFormErrors({});
      setIsCreatePlaylistOpen(false);

      // Navigate to the new playlist
      router.push(getPlaylistUrl(newPlaylist.uuid));
    } catch (error) {
      showMessage('Failed to create playlist', 'error');
    } finally {
      setIsCreatingPlaylist(false);
    }
  }, [validatePlaylistForm, createPlaylist, canCreatePlaylistHere, playlistFormValues, playlistBoardName, router, getPlaylistUrl, showMessage]);

  return (
    <>
      <BottomNavigation
        data-testid="bottom-tab-bar"
        value={activeTab}
        onChange={handleTabChange}
        showLabels
        sx={{
          background: isDark ? 'rgba(0, 0, 0, 0.4)' : 'rgba(255, 255, 255, 0.3)',
          WebkitBackdropFilter: isDark ? 'blur(20px)' : 'blur(5px)',
          backdropFilter: isDark ? 'blur(20px)' : 'blur(5px)',
          borderRadius: `${themeTokens.borderRadius.xl}px`,
          py: `${themeTokens.spacing[2]}px`,
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
          label="Home"
          icon={<HomeOutlined sx={{ fontSize: 20 }} />}
          value="home"
          sx={actionSx}
        />
        <BottomNavigationAction
          label="Climb"
          icon={<FormatListBulletedOutlined sx={{ fontSize: 20 }} />}
          value="climbs"
          sx={actionSx}
        />
        <BottomNavigationAction
          label="Your Library"
          icon={<LocalOfferOutlined sx={{ fontSize: 20 }} />}
          value="library"
          sx={actionSx}
        />
        {!isIOSNativeApp && (
          <BottomNavigationAction
            label="Feed"
            icon={<DynamicFeedOutlined sx={{ fontSize: 20 }} />}
            value="feed"
            sx={actionSx}
          />
        )}
        <BottomNavigationAction
          label="Create"
          icon={<AddOutlined sx={{ fontSize: 20 }} />}
          value="create"
          sx={actionSx}
        />
        <BottomNavigationAction
          label="Notifications"
          icon={
            <Badge
              badgeContent={notificationUnreadCount}
              color="error"
              max={99}
              sx={{ '& .MuiBadge-badge': { fontSize: 10, height: 16, minWidth: 16 } }}
            >
              <NotificationsOutlined sx={{ fontSize: 20 }} />
            </Badge>
          }
          value="notifications"
          sx={actionSx}
        />
      </BottomNavigation>

      {/* Create Menu Drawer */}
      <SwipeableDrawer
        title="Create"
        placement="bottom"
        open={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        styles={{
          wrapper: { height: 'auto' },
          body: { padding: `${themeTokens.spacing[2]}px 0` },
        }}
      >
        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
          <MuiButton
            data-testid="create-climb-option"
            variant="text"
            startIcon={<EditOutlined />}
            fullWidth
            onClick={handleOpenCreateClimb}
            sx={{
              height: 48,
              justifyContent: 'flex-start',
              paddingLeft: themeTokens.spacing[4],
              fontSize: themeTokens.typography.fontSize.base,
              color: 'inherit',
            }}
          >
            Create Climb
          </MuiButton>
          {!isMoonboard && (
            <MuiButton
              data-testid="create-playlist-option"
              variant="text"
              startIcon={<LocalOfferOutlined />}
              fullWidth
              onClick={handleOpenCreatePlaylist}
              sx={{
                height: 48,
                justifyContent: 'flex-start',
                paddingLeft: themeTokens.spacing[4],
                fontSize: themeTokens.typography.fontSize.base,
              }}
            >
              Playlist
            </MuiButton>
          )}
        </Box>
      </SwipeableDrawer>

      {/* Create Playlist Drawer */}
      <SwipeableDrawer
        title="Create Playlist"
        placement="bottom"
        open={isCreatePlaylistOpen}
        onClose={() => {
          setIsCreatePlaylistOpen(false);
          setPlaylistFormValues(INITIAL_PLAYLIST_FORM);
          setPlaylistFormErrors({});
        }}
        styles={{
          wrapper: { height: 'auto' },
          body: { padding: themeTokens.spacing[4] },
        }}
        extra={
          <MuiButton
            variant="contained"
            onClick={handleCreatePlaylist}
            disabled={isCreatingPlaylist}
          >
            {isCreatingPlaylist ? 'Creating...' : 'Create'}
          </MuiButton>
        }
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Box>
            <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>Name</Typography>
            <TextField
              placeholder="e.g., Hard Crimps"
              autoFocus
              fullWidth
              size="small"
              value={playlistFormValues.name}
              onChange={(e) => {
                setPlaylistFormValues((prev) => ({ ...prev, name: e.target.value }));
                setPlaylistFormErrors((prev) => ({ ...prev, name: '' }));
              }}
              error={!!playlistFormErrors.name}
              helperText={playlistFormErrors.name}
            />
          </Box>
          <Box>
            <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>Description (optional)</Typography>
            <TextField
              placeholder="Optional description..."
              multiline
              rows={2}
              fullWidth
              size="small"
              slotProps={{ htmlInput: { maxLength: 500 } }}
              value={playlistFormValues.description}
              onChange={(e) => {
                setPlaylistFormValues((prev) => ({ ...prev, description: e.target.value }));
                setPlaylistFormErrors((prev) => ({ ...prev, description: '' }));
              }}
              error={!!playlistFormErrors.description}
              helperText={playlistFormErrors.description}
            />
          </Box>
          <Box>
            <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>Color (optional)</Typography>
            <TextField
              type="color"
              value={playlistFormValues.color || '#000000'}
              onChange={(e) => setPlaylistFormValues((prev) => ({ ...prev, color: e.target.value }))}
              size="small"
              sx={{ width: 80 }}
            />
          </Box>
        </Box>
      </SwipeableDrawer>

      {/* Board Selector Drawer */}
      {boardConfigs && (
        <BoardSelectorDrawer
          open={isBoardSelectorOpen}
          onClose={() => {
            setIsBoardSelectorOpen(false);
            setPendingCreateAction(null);
          }}
          onBoardSelected={handleBoardSelected}
          boardConfigs={boardConfigs}
        />
      )}

      <AuthModal
        open={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        onSuccess={() => {
          setShowAuthModal(false);
          setIsCreateOpen(false);
          if (!canCreatePlaylistHere) {
            if (boardConfigs) {
              setPendingCreateAction('playlist');
              setIsBoardSelectorOpen(true);
            } else {
              showMessage('Select a board before creating a playlist', 'error');
            }
            return;
          }
          setIsCreatePlaylistOpen(true);
        }}
        title="Sign in to create playlists"
        description="Sign in to create and manage your climb playlists."
      />
    </>
  );
}

export default BottomTabBar;
