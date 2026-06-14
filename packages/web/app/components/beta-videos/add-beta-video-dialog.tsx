'use client';

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import InstagramIcon from '@mui/icons-material/Instagram';
import ContentCopyOutlined from '@mui/icons-material/ContentCopyOutlined';
import ExpandMoreOutlined from '@mui/icons-material/ExpandMoreOutlined';
import Alert from '@mui/material/Alert';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { track } from '@/app/lib/analytics';
import { buildInstagramCaption, copyInstagramCaption, openInstagramCamera } from '@/app/lib/instagram-posting';
import { themeTokens } from '@/app/theme/theme-config';
import AttachBetaLinkForm, { type AttachBetaLinkSurface } from './attach-beta-link-form';

type AddBetaVideoDialogProps = {
  open: boolean;
  onClose: () => void;
  boardType: string;
  climbUuid: string;
  climbName?: string;
  angle?: number | null;
  grade?: string | null;
  setter?: string | null;
  layoutId?: number | null;
  surface?: AttachBetaLinkSurface;
};

const AddBetaVideoDialog: React.FC<AddBetaVideoDialogProps> = ({
  open,
  onClose,
  boardType,
  climbUuid,
  climbName,
  angle,
  grade,
  setter,
  layoutId,
  surface = 'unknown',
}) => {
  const { t } = useTranslation('feed');
  const { showMessage } = useSnackbar();
  const [isCopying, setIsCopying] = useState(false);
  const [isOpeningInstagram, setIsOpeningInstagram] = useState(false);

  const caption = useMemo(() => {
    if (!climbName || angle == null) return '';
    return buildInstagramCaption({
      climbName,
      angle,
      boardType,
      grade,
      setter,
      layoutId,
    });
  }, [angle, boardType, climbName, grade, layoutId, setter]);

  const trackingProps = useMemo(
    () => ({
      boardType,
      climbUuid,
      surface,
    }),
    [boardType, climbUuid, surface],
  );

  const handleCopyCaption = async () => {
    if (!caption || isCopying) return;
    track('Beta Caption Copy Clicked', trackingProps);
    setIsCopying(true);
    try {
      const copied = await copyInstagramCaption(caption);
      if (!copied) {
        track('Beta Caption Copy Failed', { ...trackingProps, reason: 'copyFailed' });
        showMessage(t('betaVideos.instagramCopyFailed'), 'error');
        return;
      }
      track('Beta Caption Copied', { ...trackingProps, opened: false });
      showMessage(t('betaVideos.instagramCopiedOnly'), 'success');
    } catch {
      track('Beta Caption Copy Failed', { ...trackingProps, reason: 'copyFailed' });
      showMessage(t('betaVideos.instagramCopyFailed'), 'error');
    } finally {
      setIsCopying(false);
    }
  };

  const handleOpenInstagram = async () => {
    if (isOpeningInstagram) return;
    setIsOpeningInstagram(true);
    let opened = false;
    try {
      opened = await openInstagramCamera();
    } catch {
      opened = false;
    } finally {
      setIsOpeningInstagram(false);
    }
    track('Beta Instagram Open Clicked', { ...trackingProps, opened });
    if (!opened) {
      showMessage(t('betaVideos.openInstagramFailed'), 'warning');
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('betaVideos.addDialogTitle')}</DialogTitle>
      <DialogContent>
        <Stack spacing={`${themeTokens.spacing[4]}px`}>
          <Typography variant="body1" color="text.secondary">
            {t('betaVideos.addDialogIntro')}
          </Typography>
          <TextField
            label={t('betaVideos.captionLabel')}
            value={caption}
            multiline
            minRows={4}
            fullWidth
            InputProps={{ readOnly: true }}
          />
          <Alert severity="info">
            <Typography variant="subtitle2" component="div" sx={{ mb: 0.5 }}>
              {t('betaVideos.shareIntentTitle')}
            </Typography>
            <Typography variant="body2">{t('betaVideos.shareIntentBody')}</Typography>
          </Alert>
          <Accordion disableGutters>
            <AccordionSummary expandIcon={<ExpandMoreOutlined />}>
              <Typography variant="subtitle2">{t('betaVideos.pasteLinkInstead')}</Typography>
            </AccordionSummary>
            <AccordionDetails>
              <AttachBetaLinkForm
                boardType={boardType}
                climbUuid={climbUuid}
                climbName={climbName}
                angle={angle}
                grade={grade}
                setter={setter}
                layoutId={layoutId}
                surface={surface}
                resetTrigger={open}
                submitLabel={t('betaVideos.addSubmit')}
                helperText={t('betaVideos.manualLinkHelper')}
                compact
                showInstagramButton={false}
                onSuccess={onClose}
              />
            </AccordionDetails>
          </Accordion>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: `${themeTokens.spacing[6]}px`, pb: `${themeTokens.spacing[5]}px` }}>
        <Box sx={{ display: 'flex', gap: `${themeTokens.spacing[2]}px`, flexWrap: 'wrap', width: '100%' }}>
          <Button onClick={onClose}>{t('betaVideos.cancel')}</Button>
          <Box sx={{ flexGrow: 1 }} />
          <Button
            variant="outlined"
            startIcon={isCopying ? <CircularProgress size={16} /> : <ContentCopyOutlined />}
            onClick={handleCopyCaption}
            disabled={!caption || isCopying}
          >
            {t('betaVideos.copyCaption')}
          </Button>
          <Button
            variant="contained"
            startIcon={isOpeningInstagram ? <CircularProgress size={16} /> : <InstagramIcon />}
            onClick={handleOpenInstagram}
            disabled={isOpeningInstagram}
          >
            {t('betaVideos.openInstagram')}
          </Button>
        </Box>
      </DialogActions>
    </Dialog>
  );
};

export default AddBetaVideoDialog;
