'use client';

import React, { useCallback, useContext, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { track } from '@vercel/analytics';
import MuiButton from '@mui/material/Button';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import SwipeableDrawer from '@/app/components/swipeable-drawer/swipeable-drawer';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { themeTokens } from '@/app/theme/theme-config';
import { PlaylistsContext } from '@/app/components/climb-actions/playlists-batch-context';
import { useClimbActionsData } from '@/app/hooks/use-climb-actions-data';
import { isValidHexColor } from '@/app/lib/color-utils';
import type { Playlist } from '@/app/lib/graphql/operations/playlists';

const INITIAL_FORM = { name: '', description: '', color: '' };

type CreatePlaylistDrawerProps = {
  open: boolean;
  onClose: () => void;
  boardName: string;
  layoutId: number;
  angle: number;
  /** Analytics source label (e.g. "discover-fab", "library-empty-state"). */
  source: string;
  onCreated?: (playlist: Playlist) => void;
};

export default function CreatePlaylistDrawer({
  open,
  onClose,
  boardName,
  layoutId,
  angle,
  source,
  onCreated,
}: CreatePlaylistDrawerProps) {
  const { t } = useTranslation('playlists');
  const { showMessage } = useSnackbar();

  const [formValues, setFormValues] = useState(INITIAL_FORM);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRendered, setIsRendered] = useState(open);

  const playlistsContext = useContext(PlaylistsContext);
  const { playlistsProviderProps } = useClimbActionsData({
    boardName,
    layoutId,
    angle,
    climbUuids: [],
  });
  const createPlaylist = playlistsContext?.createPlaylist ?? playlistsProviderProps.createPlaylist;

  const canSubmit = !!boardName && layoutId > 0;

  // Mount lazily and keep mounted during close transition.
  if (open && !isRendered) {
    setIsRendered(true);
  }

  const handleTransitionEnd = useCallback((isOpen: boolean) => {
    if (!isOpen) setIsRendered(false);
  }, []);

  const validate = useCallback((): boolean => {
    const errors: Record<string, string> = {};
    if (!formValues.name.trim()) {
      errors.name = t('climbs:actions.playlist.validation.nameRequired');
    } else if (formValues.name.length > 100) {
      errors.name = t('climbs:actions.playlist.validation.nameTooLong');
    }
    if (formValues.description.length > 500) {
      errors.description = t('climbs:actions.playlist.validation.descriptionTooLong');
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }, [formValues, t]);

  const resetAndClose = useCallback(() => {
    setFormValues(INITIAL_FORM);
    setFormErrors({});
    onClose();
  }, [onClose]);

  const handleSubmit = useCallback(async () => {
    if (!validate()) return;

    if (!canSubmit) {
      showMessage(t('bottomTabBar.selectBoardForPlaylist'), 'error');
      return;
    }

    try {
      setIsSubmitting(true);
      const colorHex = isValidHexColor(formValues.color) ? formValues.color : undefined;

      const newPlaylist = await createPlaylist(formValues.name, formValues.description, colorHex, undefined);

      showMessage(t('bottomTabBar.createdPlaylistToast', { name: formValues.name }), 'success');
      track('Create Playlist', {
        boardName,
        playlistName: formValues.name,
        source,
      });

      setFormValues(INITIAL_FORM);
      setFormErrors({});
      onClose();
      onCreated?.(newPlaylist);
    } catch {
      showMessage(t('bottomTabBar.createPlaylistFailed'), 'error');
    } finally {
      setIsSubmitting(false);
    }
  }, [validate, canSubmit, formValues, createPlaylist, showMessage, t, boardName, source, onClose, onCreated]);

  if (!isRendered) return null;

  return (
    <SwipeableDrawer
      title={t('create.drawerTitle')}
      placement="bottom"
      open={open}
      onClose={resetAndClose}
      onTransitionEnd={handleTransitionEnd}
      styles={{
        wrapper: { height: 'auto' },
        body: { padding: themeTokens.spacing[4] },
      }}
      extra={
        <MuiButton variant="contained" onClick={handleSubmit} disabled={isSubmitting}>
          {isSubmitting ? t('create.submitting') : t('create.submit')}
        </MuiButton>
      }
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box>
          <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
            {t('create.fields.name')}
          </Typography>
          <TextField
            placeholder={t('create.fields.namePlaceholder')}
            autoFocus
            fullWidth
            size="small"
            value={formValues.name}
            onChange={(event) => {
              setFormValues((prev) => ({ ...prev, name: event.target.value }));
              setFormErrors((prev) => ({ ...prev, name: '' }));
            }}
            error={!!formErrors.name}
            helperText={formErrors.name}
          />
        </Box>
        <Box>
          <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
            {t('create.fields.description')}
          </Typography>
          <TextField
            placeholder={t('create.fields.descriptionPlaceholder')}
            multiline
            rows={2}
            fullWidth
            size="small"
            slotProps={{ htmlInput: { maxLength: 500 } }}
            value={formValues.description}
            onChange={(event) => {
              setFormValues((prev) => ({ ...prev, description: event.target.value }));
              setFormErrors((prev) => ({ ...prev, description: '' }));
            }}
            error={!!formErrors.description}
            helperText={formErrors.description}
          />
        </Box>
        <Box>
          <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
            {t('create.fields.color')}
          </Typography>
          <TextField
            type="color"
            value={formValues.color || '#000000'}
            onChange={(event) => setFormValues((prev) => ({ ...prev, color: event.target.value }))}
            size="small"
            sx={{ width: 80 }}
          />
        </Box>
      </Box>
    </SwipeableDrawer>
  );
}
