'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { track } from '@/app/lib/analytics';
import MuiButton from '@mui/material/Button';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import SwipeableDrawer from '@/app/components/swipeable-drawer/swipeable-drawer';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { themeTokens } from '@/app/theme/theme-config';
import { isValidHexColor } from '@/app/lib/color-utils';
import { executeGraphQL } from '@/app/lib/graphql/client';
import {
  CREATE_PLAYLIST,
  type CreatePlaylistMutationResponse,
  type CreatePlaylistMutationVariables,
  type Playlist,
} from '@/app/lib/graphql/operations/playlists';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';

type CreatePlaylistDrawerProps = {
  open: boolean;
  onClose: () => void;
  /**
   * Forwarded to SwipeableDrawer so callers can keep the component mounted
   * through the slide-out animation (rendered/open dual-flag pattern).
   */
  onTransitionEnd?: (open: boolean) => void;
  boardName: string;
  layoutId: number;
  source: string;
  onCreated?: (playlist: Playlist) => void;
};

const INITIAL_FORM = { name: '', description: '', color: '' };

export default function CreatePlaylistDrawer({
  open,
  onClose,
  onTransitionEnd,
  boardName,
  layoutId,
  source,
  onCreated,
}: CreatePlaylistDrawerProps) {
  const { t } = useTranslation('playlists');
  const { showMessage } = useSnackbar();
  const { token } = useWsAuthToken();
  const [formValues, setFormValues] = useState(INITIAL_FORM);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

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

  const resetForm = useCallback(() => {
    setFormValues(INITIAL_FORM);
    setFormErrors({});
  }, []);

  // The drawer is kept mounted across opens (rendered/open dual-flag pattern),
  // so reset stale form state every time the drawer transitions from closed to
  // open. Without this, name/description typed in a previous session linger.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      resetForm();
    }
    wasOpenRef.current = open;
  }, [open, resetForm]);

  const handleClose = useCallback(() => {
    resetForm();
    onClose();
  }, [resetForm, onClose]);

  const handleSubmit = useCallback(async () => {
    if (!validate()) return;

    if (!token) {
      showMessage(t('climbs:actions.playlist.auth.title'), 'error');
      return;
    }

    if (!boardName || layoutId <= 0) {
      showMessage(t('bottomTabBar.selectBoardForPlaylist'), 'error');
      return;
    }

    try {
      setSubmitting(true);
      const colorHex = formValues.color && isValidHexColor(formValues.color) ? formValues.color : undefined;

      const response = await executeGraphQL<CreatePlaylistMutationResponse, CreatePlaylistMutationVariables>(
        CREATE_PLAYLIST,
        {
          input: {
            boardType: boardName,
            layoutId,
            name: formValues.name,
            description: formValues.description || undefined,
            color: colorHex,
          },
        },
        token,
      );

      showMessage(t('bottomTabBar.createdPlaylistToast', { name: formValues.name }), 'success');
      track('Create Playlist', {
        boardName,
        playlistName: formValues.name,
        source,
      });

      resetForm();
      onClose();
      onCreated?.(response.createPlaylist);
    } catch {
      showMessage(t('bottomTabBar.createPlaylistFailed'), 'error');
    } finally {
      setSubmitting(false);
    }
  }, [validate, boardName, layoutId, formValues, token, source, showMessage, t, resetForm, onClose, onCreated]);

  return (
    <SwipeableDrawer
      title={t('create.drawerTitle')}
      placement="bottom"
      open={open}
      onClose={handleClose}
      onTransitionEnd={onTransitionEnd}
      styles={{
        wrapper: { height: 'auto' },
        body: { padding: themeTokens.spacing[4] },
      }}
      extra={
        <MuiButton variant="contained" onClick={handleSubmit} disabled={submitting}>
          {submitting ? t('create.submitting') : t('create.submit')}
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
            onChange={(e) => {
              setFormValues((prev) => ({ ...prev, name: e.target.value }));
              setFormErrors((prev) => ({ ...prev, name: '' }));
            }}
            error={!!formErrors.name}
            helperText={formErrors.name}
            slotProps={{ htmlInput: { maxLength: 100, 'aria-label': t('create.fields.name') } }}
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
            slotProps={{ htmlInput: { maxLength: 500, 'aria-label': t('create.fields.description') } }}
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
            {t('create.fields.color')}
          </Typography>
          <TextField
            type="color"
            value={formValues.color || '#000000'}
            onChange={(e) => setFormValues((prev) => ({ ...prev, color: e.target.value }))}
            size="small"
            sx={{ width: themeTokens.spacing[16] }}
            slotProps={{ htmlInput: { 'aria-label': t('create.fields.color') } }}
          />
        </Box>
      </Box>
    </SwipeableDrawer>
  );
}
