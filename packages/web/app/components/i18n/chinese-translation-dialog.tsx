'use client';

import type { ChineseTranslationLabels } from './chinese-translation-labels';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';

export type ChineseTranslationDialogProps = {
  labels: ChineseTranslationLabels;
  formUrl: string | null;
  onDismiss: () => void;
};

export default function ChineseTranslationDialog({ labels, formUrl, onDismiss }: ChineseTranslationDialogProps) {
  return (
    <Dialog open onClose={onDismiss} aria-labelledby="chinese-translation-title">
      <DialogTitle id="chinese-translation-title">{labels.title}</DialogTitle>
      <DialogContent>
        <Typography paragraph>{labels.body}</Typography>
        <Typography paragraph>{labels.terms}</Typography>
        <Typography>{formUrl ? labels.invitation : labels.formPending}</Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onDismiss}>{labels.continue}</Button>
        {formUrl ? (
          <Button
            component="a"
            href={formUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onDismiss}
            variant="contained"
          >
            {labels.openForm}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}
