'use client';

import React, { useEffect, useState } from 'react';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import { useTranslation } from 'react-i18next';
import { SESSION_NAME_MAX_LENGTH, SESSION_NOTES_MAX_LENGTH } from '@boardsesh/shared-schema';
import type { UpdateSessionVariables } from '@boardsesh/graphql/operations';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { useUpdateSession } from '@/app/hooks/use-update-session';

type UpdateSessionInput = UpdateSessionVariables['input'];

type EditSessionDialogProps = {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  /** The session's stored name (not the generated fallback title). */
  initialName: string;
  /** The session's stored recap / notes. */
  initialNotes: string;
};

/**
 * Owner-only dialog for editing a session's name and recap.
 *
 * Seeds both fields from the current session each time it opens, and on save
 * sends only the fields the owner actually changed (mirroring the backend's
 * omit-to-keep / null-to-clear contract). A trimmed-empty value clears the
 * field to null.
 */
export default function EditSessionDialog({
  open,
  onClose,
  sessionId,
  initialName,
  initialNotes,
}: EditSessionDialogProps) {
  const { t } = useTranslation('session');
  const { showMessage } = useSnackbar();
  const updateSession = useUpdateSession({ errorMessage: t('detail.editSaveFailed') });

  const [name, setName] = useState(initialName);
  const [notes, setNotes] = useState(initialNotes);

  // Reseed from the current session every time the dialog opens so a fresh edit
  // always starts from the canonical values.
  useEffect(() => {
    if (open) {
      setName(initialName);
      setNotes(initialNotes);
    }
  }, [open, initialName, initialNotes]);

  const handleSave = () => {
    const trimmedName = name.trim();
    const trimmedNotes = notes.trim();

    const input: UpdateSessionInput = { sessionId };
    let changed = false;
    if (trimmedName !== initialName.trim()) {
      input.name = trimmedName || null;
      changed = true;
    }
    if (trimmedNotes !== initialNotes.trim()) {
      input.notes = trimmedNotes || null;
      changed = true;
    }

    if (!changed) {
      onClose();
      return;
    }

    updateSession.mutate(input, {
      onSuccess: () => {
        showMessage(t('detail.editSaved'), 'success');
        onClose();
      },
    });
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t('detail.editSession')}</DialogTitle>
      <DialogContent>
        <TextField
          label={t('detail.editNameLabel')}
          placeholder={t('creation.form.sessionNamePlaceholder')}
          value={name}
          onChange={(event) => setName(event.target.value.slice(0, SESSION_NAME_MAX_LENGTH))}
          fullWidth
          size="small"
          slotProps={{ htmlInput: { maxLength: SESSION_NAME_MAX_LENGTH } }}
          sx={{ mt: 2 }}
        />
        <TextField
          label={t('detail.editRecapLabel')}
          value={notes}
          onChange={(event) => setNotes(event.target.value.slice(0, SESSION_NOTES_MAX_LENGTH))}
          multiline
          minRows={3}
          fullWidth
          size="small"
          slotProps={{ htmlInput: { maxLength: SESSION_NOTES_MAX_LENGTH } }}
          helperText={t('summary.commentHelper', { count: notes.length, max: SESSION_NOTES_MAX_LENGTH })}
          sx={{ mt: 2 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('detail.editCancel')}</Button>
        <Button onClick={handleSave} variant="contained" disabled={updateSession.isPending}>
          {t('detail.editSave')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
