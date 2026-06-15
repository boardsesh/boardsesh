'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import AttachBetaLinkForm, { type AttachBetaLinkSurface } from './attach-beta-link-form';

type AttachBetaLinkDialogProps = {
  open: boolean;
  onClose: () => void;
  boardType: string;
  climbUuid: string;
  climbName?: string;
  angle?: number | null;
  tickUuid?: string | null;
  grade?: string | null;
  setter?: string | null;
  layoutId?: number | null;
  surface?: AttachBetaLinkSurface;
};

const AttachBetaLinkDialog: React.FC<AttachBetaLinkDialogProps> = ({
  open,
  onClose,
  boardType,
  climbUuid,
  climbName,
  angle,
  tickUuid,
  grade,
  setter,
  layoutId,
  surface = 'logbook',
}) => {
  const { t } = useTranslation('feed');
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {climbName ? t('betaVideos.shareBetaFor', { name: climbName }) : t('betaVideos.shareBetaVideo')}
      </DialogTitle>
      <DialogContent>
        <AttachBetaLinkForm
          boardType={boardType}
          climbUuid={climbUuid}
          climbName={climbName}
          angle={angle}
          tickUuid={tickUuid}
          grade={grade}
          setter={setter}
          layoutId={layoutId}
          surface={surface}
          resetTrigger={open}
          submitLabel={t('betaVideos.shareBeta')}
          helperText={t('betaVideos.dialogHelper')}
          onSuccess={onClose}
          onCancel={onClose}
          showCancel
          autoFocus
          compact
        />
      </DialogContent>
    </Dialog>
  );
};

export default AttachBetaLinkDialog;
