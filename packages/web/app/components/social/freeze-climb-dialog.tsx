'use client';

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Snackbar from '@mui/material/Snackbar';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { FREEZE_CLIMB } from '@boardsesh/graphql/operations/proposals';

type FreezeClimbDialogProps = {
  open: boolean;
  onClose: () => void;
  climbUuid: string;
  boardType: string;
  currentlyFrozen: boolean;
  onFreezeChanged?: (frozen: boolean) => void;
};

export default function FreezeClimbDialog({
  open,
  onClose,
  climbUuid,
  boardType,
  currentlyFrozen,
  onFreezeChanged,
}: FreezeClimbDialogProps) {
  const { t } = useTranslation('feed');
  const { token } = useWsAuthToken();
  const [frozen, setFrozen] = useState(currentlyFrozen);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [snackbar, setSnackbar] = useState('');

  const handleSubmit = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const client = createGraphQLHttpClient(token);
      await client.request(FREEZE_CLIMB, {
        input: {
          climbUuid,
          boardType,
          frozen,
          reason: reason || null,
        },
      });
      onFreezeChanged?.(frozen);
      onClose();
    } catch {
      setSnackbar('Failed to update freeze status');
    } finally {
      setLoading(false);
    }
  }, [token, climbUuid, boardType, frozen, reason, onClose, onFreezeChanged]);

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
        <DialogTitle>{currentlyFrozen ? 'Unfreeze Climb' : 'Freeze Climb'}</DialogTitle>
        <DialogContent>
          <FormControlLabel
            control={<Switch checked={frozen} onChange={(e) => setFrozen(e.target.checked)} />}
            label={frozen ? 'Frozen (no new proposals)' : 'Not frozen'}
            sx={{ mb: 2, mt: 1 }}
          />
          <TextField
            label={t('freezeDialog.reasonLabel')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            multiline
            rows={2}
            size="small"
            fullWidth
            placeholder={t('freezeDialog.reasonPlaceholder')}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} sx={{ textTransform: 'none' }}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            variant="contained"
            disabled={loading}
            sx={{
              textTransform: 'none',
              bgcolor: 'var(--color-primary-fill)',
              '&:hover': { bgcolor: 'var(--color-primary-fill-hover)' },
            }}
          >
            {loading ? 'Saving...' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!snackbar} autoHideDuration={3000} onClose={() => setSnackbar('')} message={snackbar} />
    </>
  );
}
