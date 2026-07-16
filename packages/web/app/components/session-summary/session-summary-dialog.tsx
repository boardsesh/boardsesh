'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import FavoriteOutlined from '@mui/icons-material/FavoriteOutlined';
import { useTranslation } from 'react-i18next';
import { useSession } from 'next-auth/react';
import { SESSION_NOTES_MAX_LENGTH, type SessionSummary } from '@boardsesh/shared-schema';
import SessionSummaryView from './session-summary-view';
import { useHealthKitSync, useHealthKitAutoSync } from '@/app/hooks/use-healthkit-sync';
import { useUpdateSession } from '@/app/hooks/use-update-session';

type SessionSummaryDialogProps = {
  summary: SessionSummary | null;
  boardType?: string;
  existingWorkoutId?: string | null;
  /** When true, the session was auto-finished after inactivity. Changes the dialog title. */
  autoFinished?: boolean;
  onDismiss: () => void;
};

export default function SessionSummaryDialog({
  summary,
  boardType = '',
  existingWorkoutId,
  autoFinished = false,
  onDismiss,
}: SessionSummaryDialogProps) {
  const { t } = useTranslation('session');
  const { status: authStatus } = useSession();
  const isAuthenticated = authStatus === 'authenticated';
  const { available, state, save } = useHealthKitSync({ summary, boardType, existingWorkoutId });
  const { enabled: autoSyncEnabled, loaded: autoSyncLoaded } = useHealthKitAutoSync();
  const autoSyncedFor = useRef<string | null>(null);

  const updateSession = useUpdateSession({ errorMessage: t('summary.commentSaveFailed') });

  // Free-text recap. Seeded from the summary and tracked against the initial
  // value so we only persist when the user actually changed it.
  const [notes, setNotes] = useState('');
  const initialNotesRef = useRef('');
  const sessionId = summary?.sessionId ?? null;

  useEffect(() => {
    const seed = summary?.notes ?? '';
    setNotes(seed);
    initialNotesRef.current = seed;
  }, [sessionId, summary?.notes]);

  // Auto-sync on first dialog open for a given session.
  useEffect(() => {
    if (!summary || !available || !autoSyncLoaded) return;
    if (!autoSyncEnabled) return;
    if (autoSyncedFor.current === summary.sessionId) return;
    autoSyncedFor.current = summary.sessionId;
    void save();
  }, [summary, available, autoSyncEnabled, autoSyncLoaded, save]);

  const persistNotesIfDirty = useCallback(() => {
    if (!sessionId) return;
    const trimmed = notes.trim();
    if (trimmed === initialNotesRef.current.trim()) return;
    initialNotesRef.current = trimmed;
    // Fire-and-forget so the dialog closes immediately; errors surface via snackbar.
    updateSession.mutate({ sessionId, notes: trimmed || null });
  }, [sessionId, notes, updateSession]);

  const handleDismiss = useCallback(() => {
    persistNotesIfDirty();
    onDismiss();
  }, [persistNotesIfDirty, onDismiss]);

  let buttonLabel = t('summary.saveToAppleHealth');
  if (state === 'saving') {
    buttonLabel = t('summary.savingToAppleHealth');
  } else if (state === 'saved') {
    buttonLabel = t('summary.savedToAppleHealth');
  } else if (state === 'error') {
    buttonLabel = t('summary.saveToAppleHealthRetry');
  }

  const dialogTitle = autoFinished ? t('summary.autoFinishedDialogTitle') : t('summary.dialogTitle');

  return (
    <Dialog open={summary !== null} onClose={handleDismiss} maxWidth="sm" fullWidth>
      <DialogTitle>{dialogTitle}</DialogTitle>
      <DialogContent>
        {summary && <SessionSummaryView summary={summary} />}
        {summary && isAuthenticated && (
          <TextField
            label={t('summary.commentLabel')}
            placeholder={t('summary.commentPlaceholder')}
            value={notes}
            onChange={(event) => setNotes(event.target.value.slice(0, SESSION_NOTES_MAX_LENGTH))}
            multiline
            minRows={2}
            maxRows={4}
            fullWidth
            size="small"
            slotProps={{ htmlInput: { maxLength: SESSION_NOTES_MAX_LENGTH } }}
            helperText={t('summary.commentHelper', { count: notes.length, max: SESSION_NOTES_MAX_LENGTH })}
            sx={{ mt: 2 }}
          />
        )}
      </DialogContent>
      <DialogActions>
        {available && (
          <Button
            onClick={() => void save()}
            variant="outlined"
            startIcon={<FavoriteOutlined />}
            disabled={state === 'saving' || state === 'saved'}
          >
            {buttonLabel}
          </Button>
        )}
        <Button onClick={handleDismiss} variant="contained">
          {t('summary.done')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
