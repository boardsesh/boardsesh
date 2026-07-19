'use client';

import React, { useState, useEffect } from 'react';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import { useSession } from 'next-auth/react';
import { track } from '@/app/lib/analytics';
import { Trans, useTranslation } from 'react-i18next';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { ClientError } from 'graphql-request';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_DELETE_ACCOUNT_INFO, DELETE_ACCOUNT } from '@boardsesh/graphql/operations/account';
import { guardedNextAuthSignOut } from '@/app/lib/auth/nextauth-cookie-fetch-lock';

export default function DeleteAccountSection() {
  const { t } = useTranslation('settings');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [removeSetterName, setRemoveSetterName] = useState(false);
  const [publishedClimbCount, setPublishedClimbCount] = useState<number | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const { showMessage } = useSnackbar();
  const { token } = useWsAuthToken();
  const { data: session } = useSession();

  const isConfirmed = confirmText === 'DELETE';

  useEffect(() => {
    if (!dialogOpen || !token) return;

    let cancelled = false;
    setLoadingInfo(true);

    const client = createGraphQLHttpClient(token);
    client
      .request(GET_DELETE_ACCOUNT_INFO)
      .then((data) => {
        if (!cancelled) {
          setPublishedClimbCount(data.deleteAccountInfo.publishedClimbCount);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPublishedClimbCount(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingInfo(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [dialogOpen, token]);

  const handleOpen = () => {
    setDialogOpen(true);
    setConfirmText('');
    setRemoveSetterName(false);
    setPublishedClimbCount(null);
  };

  const handleClose = () => {
    if (deleting) return;
    setDialogOpen(false);
    setConfirmText('');
    setRemoveSetterName(false);
    setPublishedClimbCount(null);
  };

  const handleDelete = async () => {
    if (!isConfirmed || !token || !session?.user.id || !session.authSessionId) return;

    const deletedSessionIdentity = {
      userId: session.user.id,
      authSessionId: session.authSessionId,
    };

    try {
      setDeleting(true);

      const client = createGraphQLHttpClient(token);
      await client.request(DELETE_ACCOUNT, {
        input: { removeSetterName },
      });

      // Account deleted — sign out and redirect to home. Track AFTER signOut
      // resolves so a network failure on signOut doesn't record a Logout that
      // never actually happened (the GraphQL deletion already succeeded, but
      // the auth session won't be cleared until signOut completes).
      const signOutResult = await guardedNextAuthSignOut(deletedSessionIdentity, { callbackUrl: '/' });
      if (signOutResult.status === 'signed-out') {
        track('Logout', { method: 'account_deleted' });
      }
    } catch (error) {
      console.error('Delete account error:', error);
      let message = t('deleteAccount.error');
      if (error instanceof ClientError) {
        const serverMessage = error.response?.errors?.[0]?.message;
        if (serverMessage) {
          message = serverMessage;
        }
      }
      showMessage(message, 'error');
    } finally {
      setDeleting(false);
    }
  };

  const hasPublishedClimbs = publishedClimbCount !== null && publishedClimbCount > 0;

  return (
    <>
      <Card>
        <CardContent>
          <Typography variant="h5" gutterBottom>
            {t('deleteAccount.title')}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {t('deleteAccount.warning')}
          </Typography>
          <Button variant="outlined" color="error" onClick={handleOpen}>
            {t('deleteAccount.button')}
          </Button>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitle>{t('deleteAccount.dialog.title')}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {t('deleteAccount.dialog.warning')}
          </Typography>

          {loadingInfo && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {t('deleteAccount.dialog.checking')}
            </Typography>
          )}

          {hasPublishedClimbs && (
            <>
              <Typography variant="body2" sx={{ mb: 1 }}>
                <Trans
                  i18nKey="deleteAccount.dialog.publishedClimbs"
                  t={t}
                  count={publishedClimbCount ?? 0}
                  values={{ count: publishedClimbCount ?? 0 }}
                  components={{ strong: <strong /> }}
                />
              </Typography>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={removeSetterName}
                    onChange={(e) => setRemoveSetterName(e.target.checked)}
                    disabled={deleting}
                  />
                }
                label={t('deleteAccount.dialog.removeSetterName')}
                sx={{ mb: 2, display: 'flex' }}
              />
            </>
          )}

          <Typography variant="body2" sx={{ mb: 2 }}>
            <Trans i18nKey="deleteAccount.dialog.confirmInstruction" t={t} components={{ strong: <strong /> }} />
          </Typography>
          <TextField
            autoFocus
            fullWidth
            size="small"
            placeholder={t('deleteAccount.dialog.confirmPlaceholder')}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={deleting}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose} disabled={deleting}>
            {t('deleteAccount.dialog.cancel')}
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={handleDelete}
            disabled={!isConfirmed || deleting || !session?.authSessionId}
            startIcon={deleting ? <CircularProgress size={16} /> : undefined}
          >
            {t('deleteAccount.dialog.confirm')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
