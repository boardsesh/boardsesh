'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import CircularProgress from '@mui/material/CircularProgress';
import MuiAlert from '@mui/material/Alert';
import Stack from '@mui/material/Stack';
import { useTranslation } from 'react-i18next';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { getBackendHttpUrl } from '@/app/lib/backend-url';
import { remainingSeconds, isWatchPairingCode } from '@boardsesh/watch-pairing';

export default function WatchPairingSection() {
  const { t } = useTranslation('settings');
  const { token: authToken } = useWsAuthToken();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  // Monotonic id for the in-flight pair-code request. Bumped when a request
  // starts and when the dialog closes, so a stale response from a request the
  // user has since superseded (close+reopen, or a second "Regenerate" tap) is
  // dropped instead of overwriting the current code.
  const requestSeqRef = useRef(0);

  const requestCode = useCallback(async () => {
    const requestId = requestSeqRef.current + 1;
    requestSeqRef.current = requestId;

    const backendUrl = getBackendHttpUrl();
    if (!authToken || !backendUrl) {
      setHasError(true);
      return;
    }

    setLoading(true);
    setHasError(false);
    setCode(null);
    setExpiresAt(null);

    try {
      const response = await fetch(`${backendUrl}/api/watch/pair-code`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      // Drop the response if a newer request started or the dialog closed.
      if (requestId !== requestSeqRef.current) {
        return;
      }
      if (!response.ok) {
        throw new Error(`Pair code request failed: ${response.status}`);
      }
      const payload: unknown = await response.json();
      if (requestId !== requestSeqRef.current) {
        return;
      }
      if (!isWatchPairingCode(payload)) {
        throw new Error('Unexpected pair code response shape');
      }
      setCode(payload.code);
      setExpiresAt(payload.expiresAt);
    } catch (error) {
      if (requestId !== requestSeqRef.current) {
        return;
      }
      console.error('Failed to request watch pairing code:', error);
      setHasError(true);
    } finally {
      if (requestId === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [authToken]);

  // Drive the live countdown from expiresAt. Recomputes every second and
  // clears the interval on unmount, dialog close, or a fresh code.
  useEffect(() => {
    if (!expiresAt) {
      setSecondsLeft(0);
      return;
    }

    setSecondsLeft(remainingSeconds(expiresAt));
    const interval = setInterval(() => {
      const next = remainingSeconds(expiresAt);
      setSecondsLeft(next);
      if (next <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [expiresAt]);

  const handleOpen = () => {
    setDialogOpen(true);
    void requestCode();
  };

  const handleClose = () => {
    // Invalidate any in-flight request so its response can't reopen a stale code.
    requestSeqRef.current += 1;
    setDialogOpen(false);
    setCode(null);
    setExpiresAt(null);
    setHasError(false);
  };

  const isExpired = expiresAt !== null && secondsLeft <= 0;
  const showCode = !loading && !hasError && code !== null && !isExpired;
  const showRegenerate = !loading && (hasError || isExpired);

  return (
    <>
      <Card>
        <CardContent>
          <Typography variant="h5" gutterBottom>
            {t('watchPairing.title')}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
            {t('watchPairing.subtitle')}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {t('watchPairing.description')}
          </Typography>
          <Button variant="outlined" onClick={handleOpen} disabled={!authToken}>
            {t('watchPairing.generate')}
          </Button>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitle>{t('watchPairing.title')}</DialogTitle>
        <DialogContent>
          {loading && (
            <Stack direction="row" spacing={2} alignItems="center" sx={{ py: 2 }}>
              <CircularProgress size={24} />
              <Typography variant="body2" color="text.secondary">
                {t('watchPairing.generating')}
              </Typography>
            </Stack>
          )}

          {!loading && hasError && (
            <MuiAlert severity="error" sx={{ mb: 1 }}>
              {t('watchPairing.error')}
            </MuiAlert>
          )}

          {showCode && (
            <Stack spacing={1.5} alignItems="center" sx={{ py: 2 }}>
              <Typography variant="body2" color="text.secondary">
                {t('watchPairing.codeInstruction')}
              </Typography>
              <Typography
                variant="h3"
                component="p"
                sx={{
                  fontFamily: 'monospace',
                  fontWeight: 700,
                  letterSpacing: '0.25em',
                  textAlign: 'center',
                }}
              >
                {code}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t('watchPairing.expiresIn', { seconds: secondsLeft })}
              </Typography>
            </Stack>
          )}

          {!loading && !hasError && isExpired && (
            <Stack spacing={2} alignItems="center" sx={{ py: 2 }}>
              <Typography variant="body2" color="text.secondary">
                {t('watchPairing.expired')}
              </Typography>
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          {showRegenerate && (
            <Button onClick={() => void requestCode()} disabled={loading}>
              {t('watchPairing.regenerate')}
            </Button>
          )}
          <Button variant="contained" onClick={handleClose}>
            {t('watchPairing.close')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
