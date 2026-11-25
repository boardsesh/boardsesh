'use client';

import type { ConsentLabels } from './consent-labels';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import ConsentDisclosures from './consent-disclosures';

export type ConsentChoicesDialogProps = {
  labels: ConsentLabels;
  onClose: () => void;
  onChoose: (choice: 'granted' | 'denied') => void;
  syncFailed: boolean;
  disableRestoreFocus: boolean;
};

export default function ConsentChoicesDialog({
  labels,
  onClose,
  onChoose,
  syncFailed,
  disableRestoreFocus,
}: ConsentChoicesDialogProps) {
  return (
    <Dialog
      open
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="consent-choices-title"
      disableRestoreFocus={disableRestoreFocus}
    >
      <DialogTitle id="consent-choices-title">{labels.privacyChoices}</DialogTitle>
      <DialogContent>
        <ConsentDisclosures labels={labels} onClose={onClose} syncFailed={syncFailed} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{labels.close}</Button>
        <Button variant="outlined" onClick={() => onChoose('granted')}>
          {labels.allow}
        </Button>
        <Button variant="outlined" onClick={() => onChoose('denied')}>
          {labels.deny}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
