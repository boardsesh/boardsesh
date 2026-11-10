'use client';

import React, { useId } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import type { OAuthClient } from '@boardsesh/shared-schema';
import CopyValue from './copy-value';
import { RESPONSIVE_DIALOG_SX } from './app-form-dialog';

export type RevealedCredentials = {
  app: OAuthClient;
  /** Null for a public app. Lives only in the page's state until this dialog closes. */
  clientSecret: string | null;
  reason: 'created' | 'rotated';
};

type SecretDialogProps = {
  revealed: RevealedCredentials;
  onClose: () => void;
  onCopyFailed: () => void;
};

/**
 * The one time a client secret is ever on screen. It closes only through its
 * button, not a stray click or Escape, so the secret is not lost before it is
 * copied; closing drops the last reference to it.
 */
export default function SecretDialog({ revealed, onClose, onCopyFailed }: SecretDialogProps) {
  const { t } = useTranslation('developers');
  const titleId = useId();
  const { app, clientSecret, reason } = revealed;

  return (
    <Dialog open aria-labelledby={titleId} maxWidth="sm" fullWidth disableEscapeKeyDown sx={RESPONSIVE_DIALOG_SX}>
      <DialogTitle id={titleId}>
        {reason === 'created'
          ? t('secret.createdTitle', { app: app.name })
          : t('secret.rotatedTitle', { app: app.name })}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2.5}>
          {reason === 'created' ? (
            <Box>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 0.75 }}>
                {t('app.clientId')}
              </Typography>
              <CopyValue value={app.clientId} label={t('app.clientId')} onCopyFailed={onCopyFailed} />
            </Box>
          ) : null}
          {clientSecret ? (
            <>
              <Alert severity="warning" role="alert">
                {reason === 'created' ? t('secret.createdWarning') : t('secret.rotatedWarning')}
              </Alert>
              <Box>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 0.75 }}>
                  {t('secret.clientSecret')}
                </Typography>
                <CopyValue value={clientSecret} label={t('secret.clientSecret')} onCopyFailed={onCopyFailed} />
              </Box>
              <Typography variant="body2" color="text.secondary">
                {t('secret.lostHelp')}
              </Typography>
            </>
          ) : (
            <Alert severity="info">{t('secret.publicNote')}</Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, '& .MuiButton-root': { minHeight: 44 } }}>
        <Button variant="contained" onClick={onClose}>
          {clientSecret ? t('secret.confirmSaved') : t('secret.done')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
