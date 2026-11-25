'use client';

import { useTranslation } from 'react-i18next';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Typography from '@mui/material/Typography';

export type ChineseTranslationDialogProps = { formUrl: string | null; onDismiss: () => void };

export default function ChineseTranslationDialog({ formUrl, onDismiss }: ChineseTranslationDialogProps) {
  const { t } = useTranslation('common');
  return (
    <Dialog open onClose={onDismiss} aria-labelledby="chinese-translation-title">
      <DialogTitle id="chinese-translation-title">{t('chineseTranslation.title')}</DialogTitle>
      <DialogContent>
        <Typography paragraph>{t('chineseTranslation.body')}</Typography>
        <Typography paragraph>{t('chineseTranslation.terms')}</Typography>
        <Typography>{formUrl ? t('chineseTranslation.invitation') : t('chineseTranslation.formPending')}</Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onDismiss}>{t('chineseTranslation.continue')}</Button>
        {formUrl ? (
          <Button
            component="a"
            href={formUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onDismiss}
            variant="contained"
          >
            {t('chineseTranslation.openForm')}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  );
}
