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
import { signOut } from 'next-auth/react';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { ClientError } from 'graphql-request';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_DELETE_ACCOUNT_INFO,
  DELETE_ACCOUNT,
  type GetDeleteAccountInfoResponse,
  type DeleteAccountResponse,
} from '@/app/lib/graphql/operations/account';

export default function DeleteAccountSection() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [removeSetterName, setRemoveSetterName] = useState(false);
  const [publishedClimbCount, setPublishedClimbCount] = useState<number | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const { showMessage } = useSnackbar();
  const { token } = useWsAuthToken();

  const isConfirmed = confirmText === 'DELETE';

  useEffect(() => {
    if (!dialogOpen || !token) return;

    let cancelled = false;
    setLoadingInfo(true);

    const client = createGraphQLHttpClient(token);
    client
      .request<GetDeleteAccountInfoResponse>(GET_DELETE_ACCOUNT_INFO)
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
    if (!isConfirmed || !token) return;

    try {
      setDeleting(true);

      const client = createGraphQLHttpClient(token);
      await client.request<DeleteAccountResponse>(DELETE_ACCOUNT, {
        input: { removeSetterName },
      });

      // Account deleted — sign out and redirect to home
      await signOut({ callbackUrl: '/' });
    } catch (error) {
      console.error('Delete account error:', error);
      let message = 'Failed to delete account. Please try again.';
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
            Delete Account
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Permanently delete your account and all associated data. This action
            cannot be undone.
          </Typography>
          <Button variant="outlined" color="error" onClick={handleOpen}>
            Delete Account
          </Button>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitle>Delete your account?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            This is permanent. Your profile, draft climbs, logbook entries, and
            all other data will be deleted and cannot be recovered.
          </Typography>

          {loadingInfo && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Checking your climbs...
            </Typography>
          )}

          {hasPublishedClimbs && (
            <>
              <Typography variant="body2" sx={{ mb: 1 }}>
                You have <strong>{publishedClimbCount}</strong> published{' '}
                {publishedClimbCount === 1 ? 'climb' : 'climbs'} that will be
                preserved after deletion.
              </Typography>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={removeSetterName}
                    onChange={(e) => setRemoveSetterName(e.target.checked)}
                    disabled={deleting}
                  />
                }
                label="Remove my setter name from published climbs"
                sx={{ mb: 2, display: 'flex' }}
              />
            </>
          )}

          <Typography variant="body2" sx={{ mb: 2 }}>
            Type <strong>DELETE</strong> to confirm.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            size="small"
            placeholder="DELETE"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            disabled={deleting}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose} disabled={deleting}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            onClick={handleDelete}
            disabled={!isConfirmed || deleting}
            startIcon={deleting ? <CircularProgress size={16} /> : undefined}
          >
            Delete My Account
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
