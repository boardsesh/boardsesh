'use client';

import React, { useCallback } from 'react';
import IconButton from '@mui/material/IconButton';
import { IosShare } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { shareWithFallback } from '@/app/lib/share-utils';

type SetterShareButtonProps = {
  username: string;
  displayName: string;
};

/** Share control for the setter page — `navigator.share`, so client-only. */
export default function SetterShareButton({ username, displayName }: SetterShareButtonProps) {
  const { t } = useTranslation('profile');
  const { showMessage } = useSnackbar();

  const handleShare = useCallback(async () => {
    await shareWithFallback({
      url: `${window.location.origin}/setter/${encodeURIComponent(username)}`,
      title: t('setter.shareTitle', { name: displayName }),
      text: t('setter.shareText', { name: displayName }),
      trackingEvent: 'Setter Shared',
      trackingProps: { username },
      onClipboardSuccess: () => showMessage(t('setter.linkCopied'), 'success'),
      onError: () => showMessage(t('setter.shareFailed'), 'error'),
    });
  }, [username, displayName, showMessage, t]);

  return (
    <IconButton onClick={handleShare} aria-label={t('setter.shareAriaLabel')}>
      <IosShare />
    </IconButton>
  );
}
