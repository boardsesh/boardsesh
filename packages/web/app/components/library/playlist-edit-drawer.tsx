'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import dynamic from 'next/dynamic';
import { useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import MuiButton from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import MuiSwitch from '@mui/material/Switch';
import SwipeableDrawer from '@/app/components/swipeable-drawer/swipeable-drawer';
import Popover from '@mui/material/Popover';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import { PublicOutlined, LockOutlined, CloseOutlined } from '@mui/icons-material';
import { executeGraphQL } from '@/app/lib/graphql/client';
import {
  type UpdatePlaylistMutationResponse,
  type UpdatePlaylistMutationVariables,
  type Playlist,
  type PlaylistRevision,
  UPDATE_PLAYLIST,
} from '@boardsesh/graphql/operations/playlists';
import { readPlaylistUpdateConflict, type PlaylistUpdateConflict } from '@boardsesh/graphql/errors';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { themeTokens } from '@/app/theme/theme-config';

const EmojiPicker = dynamic(
  () =>
    import('@emoji-mart/react').then((mod) => {
      // Pre-load the data module alongside the picker
      return import('@emoji-mart/data').then((dataModule) => {
        const PickerComponent = mod.default;
        // Return a wrapper that injects the data prop
        const PickerWithData = (props: Record<string, unknown>) => (
          <PickerComponent data={dataModule.default} {...props} />
        );
        PickerWithData.displayName = 'EmojiPicker';
        return { default: PickerWithData };
      });
    }),
  {
    ssr: false,
    loading: () => (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', p: 4 }}>
        <CircularProgress />
      </Box>
    ),
  },
);

// Matches the server's PlaylistColorSchema (`^(#[0-9A-Fa-f]{6})?$`) exactly.
// A shorthand `#abc` would pass a looser check here and then fail validation
// server-side, sinking the whole updatePlaylist mutation, not just the colour.
const isValidHexColor = (color: string): boolean => {
  return /^#[0-9A-Fa-f]{6}$/.test(color);
};

type PlaylistEditDrawerProps = {
  open: boolean;
  playlist: Playlist;
  onClose: () => void;
  onSuccess: (updatedPlaylist: Playlist) => void;
};

const INITIAL_FORM_VALUES = { name: '', description: '', color: '', icon: '', isPublic: false };

// The conflict payload plus the name the climber actually typed, so the
// dialog can decide between the name-vs-name wording and the "details
// changed" wording (the server also conflicts on description/colour/icon/
// visibility, so both sides can carry the same name).
type PendingConflict = { data: PlaylistUpdateConflict; submittedName: string };

export default function PlaylistEditDrawer({ open, playlist, onClose, onSuccess }: PlaylistEditDrawerProps) {
  const { t } = useTranslation('playlists');
  const [formValues, setFormValues] = useState(INITIAL_FORM_VALUES);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [isPublic, setIsPublic] = useState(playlist.isPublic);
  const [emojiAnchor, setEmojiAnchor] = useState<HTMLElement | null>(null);
  const [conflict, setConflict] = useState<PendingConflict | null>(null);
  const { token } = useWsAuthToken();
  const { showMessage } = useSnackbar();
  const queryClient = useQueryClient();

  // Reset form when drawer opens with new playlist
  useEffect(() => {
    if (open && playlist) {
      setFormValues({
        name: playlist.name,
        description: playlist.description || '',
        color: playlist.color || '',
        icon: playlist.icon || '',
        isPublic: playlist.isPublic,
      });
      setFormErrors({});
      setIsPublic(playlist.isPublic);
      setConflict(null);
    }
  }, [open, playlist]);

  // The only web cache of the playlist library ('use-climb-actions-data.tsx')
  // is keyed ['userPlaylists', token] — invalidate the whole prefix so the
  // Add-to-Playlist picker picks up a rename alongside the detail page.
  const invalidatePlaylistLists = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['userPlaylists'] });
  }, [queryClient]);

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};
    if (!formValues.name.trim()) {
      errors.name = t('edit.validation.nameRequired');
    } else if (formValues.name.length > 100) {
      errors.name = t('edit.validation.nameTooLong');
    }
    if (formValues.description.length > 500) {
      errors.description = t('edit.validation.descriptionTooLong');
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Sends the mutation with the given conflict snapshot. Used both for the
  // first attempt (basedOn the loaded playlist) and for a "Keep mine" retry
  // (basedOn the server's own values, so the overwrite is deliberate).
  const saveEdit = useCallback(
    async (basedOn: PlaylistRevision | undefined) => {
      // Extract and validate hex color
      let colorHex: string | undefined;
      if (!formValues.color) {
        colorHex = '';
      } else if (isValidHexColor(formValues.color)) {
        colorHex = formValues.color;
      }

      // The server treats '' as "clear this field" and undefined as "leave
      // unchanged" — the form is seeded from the playlist, so send the values
      // as-is and an emptied description/icon/colour actually clears.
      const response = await executeGraphQL<UpdatePlaylistMutationResponse, UpdatePlaylistMutationVariables>(
        UPDATE_PLAYLIST,
        {
          input: {
            playlistId: playlist.uuid,
            name: formValues.name,
            description: formValues.description,
            color: colorHex,
            icon: formValues.icon,
            isPublic: formValues.isPublic,
            basedOn,
          },
        },
        token,
      );

      invalidatePlaylistLists();
      showMessage(t('edit.messages.updated'), 'success');
      onSuccess(response.updatePlaylist);
      onClose();
    },
    [formValues, playlist.uuid, token, onSuccess, onClose, showMessage, t, invalidatePlaylistLists],
  );

  const handleSubmit = useCallback(async () => {
    if (!validateForm()) {
      return;
    }

    try {
      setLoading(true);
      setConflict(null);

      // What this edit is based on. The server compares it against the
      // stored row and refuses rather than silently overwriting a rename
      // made on another device or client (#1934, #4267). A playlist without
      // updatedAt (a stale pre-field cache/SSR payload) falls back to the
      // old last-write-wins.
      await saveEdit(
        playlist.updatedAt
          ? {
              updatedAt: playlist.updatedAt,
              name: playlist.name,
              description: playlist.description ?? null,
              isPublic: playlist.isPublic,
              color: playlist.color ?? null,
              icon: playlist.icon ?? null,
            }
          : undefined,
      );
    } catch (error) {
      // Checked BEFORE reporting: a conflict is an expected outcome the
      // climber resolves, not a fault.
      const conflictData = readPlaylistUpdateConflict(error);
      if (conflictData) {
        setConflict({ data: conflictData, submittedName: formValues.name });
        return;
      }
      console.error('Error updating playlist:', error);
      showMessage(t('edit.messages.updateFailed'), 'error');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveEdit, playlist, formValues.name, showMessage, t]);

  // "Use theirs": no network call — adopt the server's version by merging the
  // conflict payload over the currently loaded playlist, same shape a
  // successful save would hand back.
  const handleUseTheirs = useCallback(() => {
    if (!conflict) return;
    const adopted: Playlist = {
      ...playlist,
      name: conflict.data.serverName,
      description: conflict.data.serverDescription ?? undefined,
      isPublic: conflict.data.serverIsPublic,
      color: conflict.data.serverColor ?? undefined,
      icon: conflict.data.serverIcon ?? undefined,
      updatedAt: conflict.data.serverUpdatedAt,
    };
    invalidatePlaylistLists();
    setConflict(null);
    onSuccess(adopted);
    onClose();
  }, [conflict, playlist, invalidatePlaylistLists, onSuccess, onClose]);

  // "Keep mine": retry the save re-based on the server's own values, so the
  // overwrite is deliberate rather than an accidental repeat of the same
  // conflict.
  const handleKeepMine = useCallback(async () => {
    if (!conflict) return;
    setLoading(true);
    try {
      await saveEdit({
        updatedAt: conflict.data.serverUpdatedAt,
        name: conflict.data.serverName,
        description: conflict.data.serverDescription,
        isPublic: conflict.data.serverIsPublic,
        color: conflict.data.serverColor,
        icon: conflict.data.serverIcon,
      });
      setConflict(null);
    } catch (retryError) {
      // A third device can land between this prompt and the retry. Say so
      // inline rather than chaining another prompt — a prompt chain has no
      // natural end. Saving again from the still-open drawer re-prompts with
      // the newest server values.
      if (readPlaylistUpdateConflict(retryError)) {
        setConflict(null);
        showMessage(t('edit.conflict.changedAgain'), 'error');
        return;
      }
      console.error('Error updating playlist:', retryError);
      showMessage(t('edit.messages.updateFailed'), 'error');
    } finally {
      setLoading(false);
    }
  }, [conflict, saveEdit, showMessage, t]);

  const handleConflictCancel = useCallback(() => {
    setConflict(null);
  }, []);

  const handleCancel = useCallback(() => {
    setFormValues(INITIAL_FORM_VALUES);
    setFormErrors({});
    setConflict(null);
    onClose();
  }, [onClose]);

  const handleVisibilityChange = useCallback((checked: boolean) => {
    setIsPublic(checked);
    setFormValues((prev) => ({ ...prev, isPublic: checked }));
  }, []);

  // The server also conflicts on description, colour, icon and visibility,
  // so the two names can be identical. Quoting them back would read as
  // "saved as X now, your edit says X" — say the details diverged instead.
  const conflictMessage = conflict
    ? conflict.data.serverName === conflict.submittedName
      ? t('edit.conflict.messageDetails')
      : t('edit.conflict.message', { serverName: conflict.data.serverName, yourName: conflict.submittedName })
    : '';

  return (
    <>
      <SwipeableDrawer
        title={t('edit.title')}
        open={open}
        onClose={handleCancel}
        placement="bottom"
        styles={{
          wrapper: { height: 'auto' },
          body: {
            paddingBottom: `${themeTokens.spacing[6]}px`,
          },
        }}
        extra={
          <Stack direction="row" spacing={1}>
            <MuiButton variant="outlined" onClick={handleCancel}>
              {t('edit.actions.cancel')}
            </MuiButton>
            <MuiButton variant="contained" onClick={handleSubmit} disabled={loading}>
              {loading ? t('edit.actions.saving') : t('edit.actions.save')}
            </MuiButton>
          </Stack>
        }
      >
        <Box sx={{ maxWidth: 600, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Box>
            <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
              {t('edit.fields.name')}
            </Typography>
            <TextField
              placeholder={t('edit.fields.namePlaceholder')}
              slotProps={{ htmlInput: { maxLength: 100 } }}
              fullWidth
              size="small"
              value={formValues.name}
              onChange={(e) => {
                setFormValues((prev) => ({ ...prev, name: e.target.value }));
                setFormErrors((prev) => ({ ...prev, name: '' }));
              }}
              error={!!formErrors.name}
              helperText={formErrors.name}
            />
          </Box>

          <Box>
            <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
              {t('edit.fields.description')}
            </Typography>
            <TextField
              placeholder={t('edit.fields.descriptionPlaceholder')}
              multiline
              rows={3}
              slotProps={{ htmlInput: { maxLength: 500 } }}
              fullWidth
              size="small"
              value={formValues.description}
              onChange={(e) => {
                setFormValues((prev) => ({ ...prev, description: e.target.value }));
                setFormErrors((prev) => ({ ...prev, description: '' }));
              }}
              error={!!formErrors.description}
              helperText={formErrors.description}
            />
          </Box>

          <Box>
            <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
              {t('edit.fields.color')}
            </Typography>
            <TextField
              type="color"
              value={formValues.color || '#000000'}
              onChange={(e) => setFormValues((prev) => ({ ...prev, color: e.target.value }))}
              size="small"
              sx={{ width: 80 }}
            />
          </Box>

          <Box>
            <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
              {t('edit.fields.icon')}
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <MuiButton
                variant="outlined"
                onClick={(e) => setEmojiAnchor(e.currentTarget)}
                sx={{ minWidth: 48, height: 48, fontSize: 24, lineHeight: 1 }}
              >
                {formValues.icon || '+'}
              </MuiButton>
              {formValues.icon && (
                <MuiButton
                  variant="text"
                  size="small"
                  startIcon={<CloseOutlined />}
                  onClick={() => setFormValues((prev) => ({ ...prev, icon: '' }))}
                >
                  {t('edit.fields.removeIcon')}
                </MuiButton>
              )}
            </Stack>
            <Popover
              open={Boolean(emojiAnchor)}
              anchorEl={emojiAnchor}
              onClose={() => setEmojiAnchor(null)}
              anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
            >
              <EmojiPicker
                onEmojiSelect={(emoji: { native: string }) => {
                  setFormValues((prev) => ({ ...prev, icon: emoji.native }));
                  setEmojiAnchor(null);
                }}
                theme="light"
                previewPosition="none"
              />
            </Popover>
          </Box>

          <Box>
            <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
              {t('edit.fields.visibility')}
            </Typography>
            <Stack spacing={0.5}>
              <Stack direction="row" spacing={1} alignItems="center">
                <LockOutlined sx={{ fontSize: 18, color: isPublic ? 'text.disabled' : 'text.secondary' }} />
                <MuiSwitch checked={isPublic} onChange={(_, checked) => handleVisibilityChange(checked)} />
                <PublicOutlined sx={{ fontSize: 18, color: isPublic ? 'text.secondary' : 'text.disabled' }} />
              </Stack>
              <Typography variant="body2" component="span" color="text.secondary" sx={{ fontSize: 12 }}>
                {isPublic ? t('edit.fields.publicHint') : t('edit.fields.privateHint')}
              </Typography>
            </Stack>
          </Box>
        </Box>
      </SwipeableDrawer>
      <Dialog
        open={conflict !== null}
        onClose={handleConflictCancel}
        maxWidth="xs"
        fullWidth
        aria-labelledby="playlist-edit-conflict-title"
      >
        <DialogTitle id="playlist-edit-conflict-title">{t('edit.conflict.title')}</DialogTitle>
        <DialogContent>
          <DialogContentText>{conflictMessage}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <MuiButton onClick={handleConflictCancel}>{t('edit.conflict.cancel')}</MuiButton>
          <MuiButton onClick={handleUseTheirs}>{t('edit.conflict.keepTheirs')}</MuiButton>
          <MuiButton color="error" onClick={handleKeepMine} disabled={loading}>
            {t('edit.conflict.keepMine')}
          </MuiButton>
        </DialogActions>
      </Dialog>
    </>
  );
}
