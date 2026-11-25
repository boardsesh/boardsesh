'use client';

import { useTranslation } from 'react-i18next';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import ConsentDisclosures from './consent-disclosures';

export type ConsentChoicesDialogProps = {
  onClose: () => void;
  onChoose: (choice: 'granted' | 'denied') => void;
  syncFailed: boolean;
  disableRestoreFocus: boolean;
};

export default function ConsentChoicesDialog({
  onClose,
  onChoose,
  syncFailed,
  disableRestoreFocus,
}: ConsentChoicesDialogProps) {
  const { t } = useTranslation('consent');
  return (
    <Dialog
      open
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="consent-choices-title"
      disableRestoreFocus={disableRestoreFocus}
    >
      <DialogTitle id="consent-choices-title">{t('privacyChoices')}</DialogTitle>
      <DialogContent>
        <ConsentDisclosures onClose={onClose} syncFailed={syncFailed} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('close')}</Button>
        <Button variant="outlined" onClick={() => onChoose('granted')}>
          {t('allow')}
        </Button>
        <Button variant="outlined" onClick={() => onChoose('denied')}>
          {t('deny')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
