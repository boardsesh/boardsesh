'use client';

import React, { useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import { useSession } from 'next-auth/react';
import { usePartyProfile } from '@/app/components/party-manager/party-profile-context';

const MAX_DISPLAY_NAME_LENGTH = 100;

export default function UsernameSetupDialog() {
  const { data: session, status, update } = useSession();
  const { refreshProfile } = usePartyProfile();
  const [displayName, setDisplayName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isOpen =
    status === 'authenticated' &&
    !!session?.user &&
    !session.user.name;

  const trimmedName = displayName.trim();
  const canSave = trimmedName.length > 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;

    setSaving(true);
    setError(null);

    try {
      const response = await fetch('/api/internal/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: trimmedName }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || 'Failed to save name');
      }

      // Refresh the JWT session so session.user.name updates immediately
      await update();
      // Refresh party profile context so username propagates to sessions
      await refreshProfile();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Dialog
      open
      disableEscapeKeyDown
      onClose={(_event, reason) => {
        // Prevent closing by backdrop click
        if (reason === 'backdropClick') return;
      }}
      maxWidth="xs"
      fullWidth
      PaperProps={{
        sx: { borderRadius: 3 },
      }}
    >
      <DialogTitle>Pick a name</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          This is how other crushers will see you.
        </Typography>
        <TextField
          autoFocus
          fullWidth
          label="Display name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSave) {
              handleSave();
            }
          }}
          inputProps={{ maxLength: MAX_DISPLAY_NAME_LENGTH }}
          error={!!error}
          helperText={error}
          disabled={saving}
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={!canSave}
          startIcon={saving ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
