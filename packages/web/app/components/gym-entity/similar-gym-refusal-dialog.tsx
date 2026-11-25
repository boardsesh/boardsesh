'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogActions from '@mui/material/DialogActions';
import MuiButton from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import type { SimilarGym } from '@boardsesh/shared-schema';
import SimilarGymList from './similar-gym-list';

type SimilarGymRefusalDialogProps = {
  /** The gyms createGym's GYM_SIMILAR_EXISTS refusal named; null or empty keeps the dialog closed. */
  gyms: readonly SimilarGym[] | null;
  /** True while the confirmed create is on its way. */
  isSubmitting: boolean;
  /** "No, add a new gym": resend saying every gym shown is a different one. */
  onConfirmSeparate: () => void;
  onClose: () => void;
};

/**
 * "Is it one of these?" Shown when the server refuses a create because similar
 * gyms are already listed. Each gym links to its page and offers Claim where the
 * climber may; "No, add a new gym" resends the create as CONFIRMED_SEPARATE.
 */
export default function SimilarGymRefusalDialog({
  gyms,
  isSubmitting,
  onConfirmSeparate,
  onClose,
}: SimilarGymRefusalDialogProps) {
  const { t } = useTranslation('boards');
  const open = gyms != null && gyms.length > 0;

  return (
    <Dialog open={open} onClose={isSubmitting ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('similarGyms.refusal.title')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <DialogContentText>{t('similarGyms.refusal.body')}</DialogContentText>
        {gyms && <SimilarGymList gyms={gyms} claimPlacement="similar-gyms-refusal" />}
      </DialogContent>
      <DialogActions>
        <MuiButton variant="text" onClick={onClose} disabled={isSubmitting}>
          {t('similarGyms.refusal.back')}
        </MuiButton>
        <MuiButton variant="contained" onClick={onConfirmSeparate} disabled={isSubmitting}>
          {isSubmitting ? <CircularProgress size={20} color="inherit" /> : t('similarGyms.refusal.addNew')}
        </MuiButton>
      </DialogActions>
    </Dialog>
  );
}
