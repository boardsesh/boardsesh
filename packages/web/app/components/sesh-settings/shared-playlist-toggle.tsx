'use client';

import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import { themeTokens } from '@/app/theme/theme-config';
import { usePersistentSessionState } from '@/app/components/persistent-session';
import { useSetSessionSharedPlaylist } from '@/app/hooks/use-set-session-shared-playlist';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';

/**
 * Toggle the shared-playlist queue flag for the active session.
 *
 * Flipping the switch opens a confirmation dialog (the wording differs for
 * enable vs disable since the consequences differ — disabling stops sync,
 * enabling does not merge existing local queues). Confirming fires the
 * optimistic mutation in `useSetSessionSharedPlaylist`; cancelling leaves
 * everything untouched.
 *
 * Renders nothing when there's no active session — the toggle is meaningless
 * without one. The parent `<SeshSettingsDrawer>` already guards rendering on
 * session presence, but this is a defensive belt-and-braces check.
 */
export default function SharedPlaylistToggle() {
  const { t } = useTranslation('session');
  const { activeSession } = usePersistentSessionState();
  const { setEnabled, isLoading, error } = useSetSessionSharedPlaylist();
  const { showMessage } = useSnackbar();

  // Default to `true` for legacy IDB rows that pre-date the field — mirrors
  // the queue-bridge fallback so the UI matches the runtime behaviour.
  const currentValue = activeSession?.sharedPlaylistEnabled ?? true;

  // The pending switch value the user is trying to commit to. Null when
  // there's no open confirmation dialog. Holding it here (rather than
  // applying it on switch toggle) keeps the optimistic update out of the
  // critical path — the toggle visually flips only after the user confirms.
  const [pendingValue, setPendingValue] = useState<boolean | null>(null);

  const handleSwitchChange = useCallback(
    (_event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => {
      if (checked === currentValue) return;
      setPendingValue(checked);
    },
    [currentValue],
  );

  const handleCancel = useCallback(() => {
    setPendingValue(null);
  }, []);

  const handleConfirm = useCallback(async () => {
    if (pendingValue === null) return;
    const target = pendingValue;
    setPendingValue(null);
    try {
      await setEnabled(target);
    } catch {
      // `useSetSessionSharedPlaylist` already rolled back the optimistic
      // patch + surfaced via `error`; the snackbar effect below picks it
      // up and renders a toast.
    }
  }, [pendingValue, setEnabled]);

  React.useEffect(() => {
    if (error) {
      showMessage(t('settings.sharedPlaylist.updateFailed'), 'error');
    }
  }, [error, showMessage, t]);

  if (!activeSession) return null;

  const dialogOpen = pendingValue !== null;
  const willEnable = pendingValue === true;
  // Resolve the body + confirm copy with static-literal t() calls so the
  // i18n orphan linter can statically prove these keys are live (it bails
  // out on `t(variable)`). Switching on `willEnable` here keeps the dialog
  // wording in sync with the user's intent.
  const dialogBody = willEnable
    ? t('settings.sharedPlaylist.confirmEnableBody')
    : t('settings.sharedPlaylist.confirmDisableBody');
  const dialogConfirm = willEnable
    ? t('settings.sharedPlaylist.confirmEnable')
    : t('settings.sharedPlaylist.confirmDisable');

  return (
    <Box
      sx={{
        px: `${themeTokens.spacing[3]}px`,
        py: `${themeTokens.spacing[2]}px`,
        borderBottom: '1px solid',
        borderColor: 'divider',
      }}
    >
      <FormControlLabel
        control={
          <Switch
            checked={currentValue}
            onChange={handleSwitchChange}
            disabled={isLoading}
            inputProps={{ 'aria-label': t('settings.sharedPlaylist.label') }}
          />
        }
        label={
          <Typography variant="body2" sx={{ fontWeight: themeTokens.typography.fontWeight.medium }}>
            {t('settings.sharedPlaylist.label')}
          </Typography>
        }
        sx={{ ml: 0, mb: 0.5 }}
      />
      <Typography variant="caption" color="text.secondary" component="div">
        {t('settings.sharedPlaylist.description')}
      </Typography>

      <Dialog open={dialogOpen} onClose={handleCancel} aria-labelledby="shared-playlist-confirm-title">
        <DialogTitle id="shared-playlist-confirm-title">{t('settings.sharedPlaylist.confirmTitle')}</DialogTitle>
        <DialogContent>
          <DialogContentText>{dialogBody}</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCancel} disabled={isLoading}>
            {t('settings.sharedPlaylist.cancel')}
          </Button>
          <Button onClick={handleConfirm} variant="contained" color="primary" disabled={isLoading} autoFocus>
            {dialogConfirm}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
