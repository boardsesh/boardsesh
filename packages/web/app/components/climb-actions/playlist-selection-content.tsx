'use client';

import React, { useCallback, useState } from 'react';
import MuiButton from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import MuiTypography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';
import MuiList from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import Stack from '@mui/material/Stack';
import AddOutlined from '@mui/icons-material/AddOutlined';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import { track } from '@/app/lib/analytics';
import { usePlaylists } from './use-playlists';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import type { Playlist } from './playlists-batch-context';
import type { BoardDetails } from '@/app/lib/types';
import { themeTokens } from '@/app/theme/theme-config';
import { useSnackbar } from '../providers/snackbar-provider';
import { isValidHexColor } from '@/app/lib/color-utils';

type PlaylistSelectionContentProps = {
  climbUuid: string;
  boardDetails: BoardDetails;
  angle: number;
  onDone?: () => void;
};

export default function PlaylistSelectionContent({
  climbUuid,
  boardDetails,
  angle,
  onDone,
}: PlaylistSelectionContentProps) {
  const { openAuthModal } = useAuthModal();
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
    climbUuid,
    angle,
  });

  const { showMessage } = useSnackbar();

  const handleTogglePlaylist = useCallback(
    async (playlistId: string, isInPlaylist: boolean) => {
      try {
        if (isInPlaylist) {
          await removeFromPlaylist(playlistId);
          showMessage('Removed from playlist', 'success');
          track('Remove from Playlist', {
            boardName: boardDetails.board_name,
            climbUuid,
            playlistId,
          });
        } else {
          await addToPlaylist(playlistId);
          showMessage('Added to playlist', 'success');
          track('Add to Playlist', {
            boardName: boardDetails.board_name,
            climbUuid,
            playlistId,
          });
        }
      } catch {
        showMessage(isInPlaylist ? 'Failed to remove from playlist' : 'Failed to add to playlist', 'error');
      }
    },
    [addToPlaylist, removeFromPlaylist, boardDetails.board_name, climbUuid, showMessage],
  );

  const handleCreatePlaylist = useCallback(async () => {
    try {
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

      const colorHex =
        createFormValues.color && isValidHexColor(createFormValues.color) ? createFormValues.color : undefined;
      const newPlaylist = await createPlaylist(
        createFormValues.name,
        createFormValues.description,
        colorHex,
        undefined,
      );

      await addToPlaylist(newPlaylist.uuid);

      showMessage(`Created playlist "${createFormValues.name}"`, 'success');
      track('Create Playlist', {
        boardName: boardDetails.board_name,
        playlistName: createFormValues.name,
      });

      setCreateFormValues({ name: '', description: '', color: '' });
      setShowCreateForm(false);
      onDone?.();
    } catch {
      showMessage('Failed to create playlist', 'error');
    } finally {
      setCreatingPlaylist(false);
    }
  }, [createFormValues, createPlaylist, addToPlaylist, boardDetails.board_name, onDone, showMessage]);

  const handlePlaylistItemKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLLIElement>, playlistId: string, isInPlaylist: boolean) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        void handleTogglePlaylist(playlistId, isInPlaylist);
      }
    },
    [handleTogglePlaylist],
  );

  return (
    <Box
      sx={{
        padding: `${themeTokens.spacing[2]}px ${themeTokens.spacing[2]}px ${themeTokens.spacing[3]}px`,
      }}
    >
      <Box sx={{ marginBottom: themeTokens.spacing[1] }}>
        <MuiTypography
          component="span"
          sx={{
            fontWeight: themeTokens.typography.fontWeight.semibold,
            fontSize: themeTokens.typography.fontSize.base,
          }}
        >
          Add to Playlist
        </MuiTypography>
      </Box>

      {!isAuthenticated ? (
        <Stack spacing={1} sx={{ width: '100%', textAlign: 'center', py: themeTokens.spacing[1] }}>
          <MuiTypography component="span" color="text.secondary" sx={{ fontSize: themeTokens.typography.fontSize.sm }}>
            Sign in to create and manage playlists
          </MuiTypography>
          <MuiButton
            variant="contained"
            onClick={() =>
              openAuthModal({
                title: 'Sign in to create playlists',
                description: 'Sign in to organize your climbs into custom playlists.',
              })
            }
            fullWidth
            size="small"
          >
            Sign In
          </MuiButton>
        </Stack>
      ) : playlists.length === 0 && !showCreateForm ? (
        <Stack spacing={1} sx={{ width: '100%', textAlign: 'center', py: themeTokens.spacing[1] }}>
          <MuiTypography component="span" color="text.secondary" sx={{ fontSize: themeTokens.typography.fontSize.sm }}>
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
                        onClick={() => void handleTogglePlaylist(playlist.uuid, isInPlaylist)}
                        onKeyDown={(event) => handlePlaylistItemKeyDown(event, playlist.uuid, isInPlaylist)}
                        role="button"
                        tabIndex={0}
                        aria-pressed={isInPlaylist}
                        aria-label={`${isInPlaylist ? 'Remove from' : 'Add to'} playlist ${playlist.name}`}
                        sx={{
                          padding: `${themeTokens.spacing[2]}px ${themeTokens.spacing[2]}px`,
                          cursor: 'pointer',
                          borderLeft: validColor ? `3px solid ${validColor}` : '3px solid transparent',
                          borderRadius: `${themeTokens.borderRadius.sm}px`,
                          mb: 0.5,
                          backgroundColor: isInPlaylist ? 'var(--semantic-selected-light)' : undefined,
                        }}
                      >
                        <Stack direction="row" spacing={1} sx={{ width: '100%', justifyContent: 'space-between' }}>
                          <Stack spacing={0}>
                            <MuiTypography
                              component="span"
                              fontWeight={600}
                              sx={{ fontSize: themeTokens.typography.fontSize.base }}
                            >
                              {playlist.name}
                            </MuiTypography>
                            <MuiTypography
                              component="span"
                              color="text.secondary"
                              sx={{ fontSize: themeTokens.typography.fontSize.sm }}
                            >
                              {playlist.climbCount} {playlist.climbCount === 1 ? 'climb' : 'climbs'}
                            </MuiTypography>
                          </Stack>
                          {isInPlaylist && <CheckOutlined sx={{ color: themeTokens.colors.success, fontSize: 18 }} />}
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
                size="medium"
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
              <Stack
                direction="row"
                spacing={1}
                sx={{ width: '100%', justifyContent: 'flex-end', mt: themeTokens.spacing[2] }}
              >
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
    </Box>
  );
}
