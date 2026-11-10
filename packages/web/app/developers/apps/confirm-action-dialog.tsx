'use client';

import React, { useId } from 'react';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';

type ConfirmActionDialogProps = {
  title: string;
  /** One paragraph each. */
  paragraphs: string[];
  confirmLabel: string;
  workingLabel: string;
  /** Red for an action that cannot be taken back. */
  destructive: boolean;
  working: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

/**
 * Rotate and delete both end something for good, so focus starts on Cancel: a
 * stray Enter never confirms. While the request runs, nothing closes the dialog.
 */
export default function ConfirmActionDialog({
  title,
  paragraphs,
  confirmLabel,
  workingLabel,
  destructive,
  working,
  onConfirm,
  onClose,
}: ConfirmActionDialogProps) {
  const { t } = useTranslation('developers');
  const titleId = useId();
  return (
    <Dialog open onClose={working ? undefined : onClose} aria-labelledby={titleId} maxWidth="xs" fullWidth>
      <DialogTitle id={titleId}>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          {paragraphs.map((paragraph) => (
            <Typography key={paragraph} variant="body2" color="text.secondary">
              {paragraph}
            </Typography>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, gap: 1, '& .MuiButton-root': { minHeight: 44 } }}>
        <Button onClick={onClose} disabled={working} autoFocus>
          {t('form.cancel')}
        </Button>
        <Button
          variant="contained"
          color={destructive ? 'error' : 'primary'}
          onClick={onConfirm}
          disabled={working}
          startIcon={working ? <CircularProgress size={18} color="inherit" aria-hidden /> : undefined}
        >
          {working ? workingLabel : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
