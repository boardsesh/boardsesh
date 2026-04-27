'use client';

import React, { useState, useCallback } from 'react';
import MuiButton from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import MuiTypography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import MuiList from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import MuiBadge from '@mui/material/Badge';
import Stack from '@mui/material/Stack';
import { ActionTooltip } from '../action-tooltip';
import LocalOfferOutlined from '@mui/icons-material/LocalOfferOutlined';
import AddOutlined from '@mui/icons-material/AddOutlined';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import { track } from '@/app/lib/analytics';
import type { ClimbActionProps, ClimbActionResult } from '../types';
import { usePlaylists } from '../use-playlists';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import type { Playlist } from '../playlists-batch-context';
import { themeTokens } from '@/app/theme/theme-config';
import { useSnackbar } from '../../providers/snackbar-provider';

// Validate hex color format to prevent CSS injection
const isValidHexColor = (color: string): boolean => {
  return /^#([0-9A-Fa-f]{3}){1,2}$/.test(color);
};

export function PlaylistAction({
  climb,
  boardDetails,
  angle,
  viewMode,
  size = 'default',
  showLabel,
  disabled,
  className,
  onComplete,
  onOpenPlaylistSelector,
}: ClimbActionProps): ClimbActionResult {
  // Playlists not supported for moonboard yet
  const isMoonboard = boardDetails.board_name === 'moonboard';

  const { openAuthModal } = useAuthModal();
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createFormValues, setCreateFormValues] = useState({
    name: '',
    description: '',
    color: '',
  });
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);

  const {
    playlists,
    playlistsContainingClimb,
    addToPlaylist,
    removeFromPlaylist,
    createPlaylist,
    isAuthenticated,
    isLoading,
  } = usePlaylists({
    climbUuid: climb.uuid,
    angle,
  });

  const handleClick = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      e?.preventDefault();

      if (!isAuthenticated) {
        openAuthModal({
          title: 'Sign in to create playlists',
          description: 'Sign in to organize your climbs into custom playlists.',
        });
        return;
      }

      if (viewMode === 'list' && onOpenPlaylistSelector) {
        onOpenPlaylistSelector();
        onComplete?.();
        return;
      }

      setPopoverOpen((prev) => !prev);
    },
    [isAuthenticated, onComplete, onOpenPlaylistSelector, viewMode, openAuthModal],
  );

  const { showMessage } = useSnackbar();

  const handleTogglePlaylist = useCallback(
    async (playlistId: string, isInPlaylist: boolean) => {
      try {
        if (isInPlaylist) {
          await removeFromPlaylist(playlistId);
          showMessage('Removed from playlist', 'success');
          track('Remove from Playlist', {
            boardName: boardDetails.board_name,
            climbUuid: climb.uuid,
            playlistId,
          });
        } else {
          await addToPlaylist(playlistId);
          showMessage('Added to playlist', 'success');
          track('Add to Playlist', {
            boardName: boardDetails.board_name,
            climbUuid: climb.uuid,
            playlistId,
          });
        }
        onComplete?.();
        // Note: No need to call refreshPlaylists() - optimistic updates handle state
      } catch {
        showMessage(isInPlaylist ? 'Failed to remove from playlist' : 'Failed to add to playlist', 'error');
      }
    },
    [addToPlaylist, removeFromPlaylist, boardDetails.board_name, climb.uuid, onComplete, showMessage],
  );

  const handleCreatePlaylist = useCallback(async () => {
    try {
      // Inline validation
      if (!createFormValues.name.trim()) {
        showMessage('Please enter a playlist name', 'error');
        return;
      }
      if (createFormValues.name.length > 100) {
        showMessage('Name too long', 'error');
        return;
      }
      if (createFormValues.description.length > 500) {
        showMessage('Description too long', 'error');
        return;
      }

      setCreatingPlaylist(true);

      // Extract and validate hex color
      const colorHex =
        createFormValues.color && isValidHexColor(createFormValues.color) ? createFormValues.color : undefined;

      const newPlaylist = await createPlaylist(
        createFormValues.name,
        createFormValues.description,
        colorHex,
        undefined,
      );

      // Automatically add current climb to new playlist
      await addToPlaylist(newPlaylist.uuid);

      showMessage(`Created playlist "${createFormValues.name}"`, 'success');
      track('Create Playlist', {
        boardName: boardDetails.board_name,
        playlistName: createFormValues.name,
      });

      setCreateFormValues({ name: '', description: '', color: '' });
      setShowCreateForm(false);
      onComplete?.();
      // Note: No need to call refreshPlaylists() - optimistic updates handle state
    } catch {
      showMessage('Failed to create playlist', 'error');
    } finally {
      setCreatingPlaylist(false);
    }
  }, [createFormValues, createPlaylist, addToPlaylist, boardDetails.board_name, onComplete, showMessage]);

  const inlineContent = (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        padding: themeTokens.spacing[3],
        backgroundColor: 'var(--semantic-surface-overlay)',
        overflow: 'auto',
        zIndex: themeTokens.zIndex.dropdown,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ marginBottom: themeTokens.spacing[2] }}>
        <MuiTypography variant="body2" component="span" fontWeight={600}>
          Add to Playlist
        </MuiTypography>
      </div>
      {playlists.length === 0 && !showCreateForm ? (
        <Stack spacing={1} style={{ width: '100%', textAlign: 'center', padding: themeTokens.spacing[2] }}>
          <MuiTypography variant="body2" component="span" color="text.secondary">
            No playlists yet
          </MuiTypography>
          <MuiButton
            variant="contained"
            startIcon={<AddOutlined />}
            onClick={() => setShowCreateForm(true)}
            fullWidth
            size="small"
          >
            Create Your First Playlist
          </MuiButton>
        </Stack>
      ) : (
        <>
          {!showCreateForm && (
            <>
              <MuiList dense disablePadding>
                {isLoading ? (
                  <CircularProgress size={20} />
                ) : (
                  playlists.map((playlist: Playlist) => {
                    const isInPlaylist = playlistsContainingClimb.has(playlist.uuid);
                    const validColor = playlist.color && isValidHexColor(playlist.color) ? playlist.color : null;
                    return (
                      <ListItem
                        key={playlist.uuid}
                        onClick={() => handleTogglePlaylist(playlist.uuid, isInPlaylist)}
                        sx={{
                          padding: `${themeTokens.spacing[1] + 2}px ${themeTokens.spacing[2]}px`,
                          cursor: 'pointer',
                          borderLeft: validColor ? `3px solid ${validColor}` : '3px solid transparent',
                          borderRadius: `${themeTokens.borderRadius.sm}px`,
                          mb: 0.5,
                          backgroundColor: isInPlaylist ? 'var(--semantic-selected-light)' : undefined,
                        }}
                      >
                        <Stack direction="row" spacing={1} sx={{ width: '100%', justifyContent: 'space-between' }}>
                          <Stack spacing={0}>
                            <MuiTypography variant="body2" component="span" fontWeight={600} sx={{ fontSize: 13 }}>
                              {playlist.name}
                            </MuiTypography>
                            <MuiTypography
                              variant="body2"
                              component="span"
                              color="text.secondary"
                              sx={{ fontSize: 11 }}
                            >
                              {playlist.climbCount} {playlist.climbCount === 1 ? 'climb' : 'climbs'}
                            </MuiTypography>
                          </Stack>
                          {isInPlaylist && <CheckOutlined sx={{ color: themeTokens.colors.success, fontSize: 14 }} />}
                        </Stack>
                      </ListItem>
                    );
                  })
                )}
              </MuiList>
              <MuiButton
                variant="outlined"
                startIcon={<AddOutlined />}
                onClick={() => setShowCreateForm(true)}
                fullWidth
                size="small"
                sx={{ marginTop: `${themeTokens.spacing[2]}px` }}
              >
                Create New Playlist
              </MuiButton>
            </>
          )}

          {showCreateForm && (
            <div>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <Box>
                  <MuiTypography variant="body2" fontWeight={600} sx={{ mb: 0.5, fontSize: 12 }}>
                    Playlist Name
                  </MuiTypography>
                  <TextField
                    placeholder="e.g., Hard Crimps"
                    autoFocus
                    fullWidth
                    size="small"
                    value={createFormValues.name}
                    onChange={(e) => setCreateFormValues((prev) => ({ ...prev, name: e.target.value }))}
                    slotProps={{ htmlInput: { maxLength: 100 } }}
                  />
                </Box>
                <Box>
                  <MuiTypography variant="body2" fontWeight={600} sx={{ mb: 0.5, fontSize: 12 }}>
                    Description (optional)
                  </MuiTypography>
                  <TextField
                    placeholder="Optional description..."
                    multiline
                    rows={2}
                    fullWidth
                    size="small"
                    value={createFormValues.description}
                    onChange={(e) => setCreateFormValues((prev) => ({ ...prev, description: e.target.value }))}
                    slotProps={{ htmlInput: { maxLength: 500 } }}
                  />
                </Box>
                <Box>
                  <MuiTypography variant="body2" fontWeight={600} sx={{ mb: 0.5, fontSize: 12 }}>
                    Color (optional)
                  </MuiTypography>
                  <TextField
                    type="color"
                    value={createFormValues.color || '#000000'}
                    onChange={(e) => setCreateFormValues((prev) => ({ ...prev, color: e.target.value }))}
                    size="small"
                    sx={{ width: 60 }}
                  />
                </Box>
              </Box>
              <Stack direction="row" spacing={1} style={{ width: '100%', justifyContent: 'flex-end' }}>
                <MuiButton
                  variant="outlined"
                  size="small"
                  onClick={() => {
                    setShowCreateForm(false);
                    setCreateFormValues({ name: '', description: '', color: '' });
                  }}
                >
                  Cancel
                </MuiButton>
                <MuiButton
                  variant="contained"
                  size="small"
                  onClick={handleCreatePlaylist}
                  disabled={creatingPlaylist}
                  startIcon={creatingPlaylist ? <CircularProgress size={16} /> : undefined}
                >
                  Create
                </MuiButton>
              </Stack>
            </div>
          )}
        </>
      )}
    </div>
  );

  const label = 'Add to Playlist';
  const shouldShowLabel = showLabel ?? (viewMode === 'button' || viewMode === 'dropdown');
  const iconSize = size === 'small' ? 14 : size === 'large' ? 20 : 16;

  const inPlaylistCount = playlistsContainingClimb.size;
  const icon = popoverOpen ? (
    <CloseOutlined sx={{ fontSize: iconSize }} />
  ) : inPlaylistCount > 0 ? (
    <MuiBadge badgeContent={inPlaylistCount} sx={{ '& .MuiBadge-badge': { top: 2, right: -2 } }}>
      <LocalOfferOutlined sx={{ fontSize: iconSize }} />
    </MuiBadge>
  ) : (
    <LocalOfferOutlined sx={{ fontSize: iconSize }} />
  );

  // Icon mode - for Card actions (renders inline content below when expanded)
  const iconElement = (
    <ActionTooltip title={label}>
      <span onClick={handleClick} style={{ cursor: 'pointer' }} className={className}>
        {icon}
      </span>
    </ActionTooltip>
  );

  // Button mode
  const buttonElement = (
    <MuiButton
      variant="outlined"
      startIcon={icon}
      onClick={handleClick}
      size={size === 'large' ? 'large' : 'small'}
      disabled={disabled}
      className={className}
    >
      {shouldShowLabel && label}
    </MuiButton>
  );

  // Menu item for dropdown
  const menuItem = {
    key: 'playlist',
    label: inPlaylistCount > 0 ? `${label} (${inPlaylistCount})` : label,
    icon: <LocalOfferOutlined />,
    onClick: () => handleClick(),
  };

  // Inline expandable content for card mode
  const expandedContent = popoverOpen ? inlineContent : null;

  // List mode - full-width row for drawer menus
  const listElement = (
    <MuiButton
      variant="text"
      startIcon={icon}
      fullWidth
      onClick={handleClick}
      disabled={disabled}
      sx={{
        height: 48,
        justifyContent: 'flex-start',
        paddingLeft: `${themeTokens.spacing[4]}px`,
        fontSize: themeTokens.typography.fontSize.base,
      }}
    >
      {inPlaylistCount > 0 ? `${label} (${inPlaylistCount})` : label}
    </MuiButton>
  );

  let element: React.ReactNode;
  switch (viewMode) {
    case 'icon':
      element = iconElement;
      break;
    case 'button':
    case 'compact':
      element = buttonElement;
      break;
    case 'list':
      element = listElement;
      break;
    case 'dropdown':
      element = null;
      break;
    default:
      element = iconElement;
  }

  return {
    element,
    expandedContent,
    menuItem,
    key: 'playlist',
    available: !isMoonboard,
  };
}

export default PlaylistAction;
