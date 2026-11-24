'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';

/** The board a save would copy, as the server named it. Both null when it withheld the identity (a non-owner editor). */
export type DuplicateBoardConfig = { name: string | null; locationName: string | null };

type DuplicateBoardConfigDialogProps = {
  open: boolean;
  /** Kept while the dialog fades out, so its body doesn't flash the generic copy. */
  duplicate: DuplicateBoardConfig | null;
  saving: boolean;
  onClose: () => void;
  onSaveAnyway: () => void;
  /** The fade-out finished: clear `duplicate` here, not on close. */
  onExited: () => void;
};

/**
 * "You already have this board": an `updateBoard` refused with
 * `BOARD_DUPLICATE_CONFIG` (`isDuplicateBoardError`). A choice, not a failure:
 * since #4174 the same wall can exist twice (home and gym), so Save anyway
 * replays the save with `allowDuplicateConfig`. A dialog rather than a
 * snackbar, whose one action slot can't carry a choice.
 *
 * Shared by the edit-board form and Manage gym's Use this setup.
 */
export default function DuplicateBoardConfigDialog({
  open,
  duplicate,
  saving,
  onClose,
  onSaveAnyway,
  onExited,
}: DuplicateBoardConfigDialogProps) {
  const { t } = useTranslation('boards');
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      TransitionProps={{ onExited }}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>{t('boardForm.edit.duplicateTitle')}</DialogTitle>
      <DialogContent>
        <DialogContentText>
          {duplicate?.name && duplicate.locationName
            ? t('boardForm.edit.duplicateBodyWithLocation', {
                name: duplicate.name,
                location: duplicate.locationName,
              })
            : duplicate?.name
              ? t('boardForm.edit.duplicateBody', { name: duplicate.name })
              : t('boardForm.edit.duplicateBodyGeneric')}
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button disabled={saving} onClick={onClose}>
          {t('boardForm.edit.cancel')}
        </Button>
        <Button disabled={saving} onClick={onSaveAnyway} variant="contained">
          {t('boardForm.edit.saveAnyway')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
