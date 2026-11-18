'use client';

import React, { useEffect, useState } from 'react';
import IconButton from '@mui/material/IconButton';
import { useTranslation } from 'react-i18next';
import ArrowBackOutlined from '@mui/icons-material/ArrowBackOutlined';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';

type BackButtonProps = {
  fallbackUrl?: string;
  className?: string;
};

const BackButton = ({ fallbackUrl, className }: BackButtonProps) => {
  const router = useLocaleRouter();
  const { t } = useTranslation('common');
  const [canGoBack, setCanGoBack] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const hasHistory = window.history.length > 1;
      const referrer = document.referrer;
      let isBoardseshReferrer = false;

      if (referrer) {
        try {
          const refUrl = new URL(referrer);
          const host = refUrl.hostname;
          const currentHost = window.location.hostname;
          isBoardseshReferrer =
            host === currentHost ||
            host.endsWith('boardsesh.com') ||
            host.endsWith('boardsesh.io') ||
            host === 'localhost';
        } catch {
          isBoardseshReferrer = false;
        }
      }

      setCanGoBack(hasHistory && isBoardseshReferrer);
    }
  }, []);

  // Prefetch fallback URL for faster navigation
  useEffect(() => {
    if (!canGoBack && fallbackUrl) {
      router.prefetch(fallbackUrl);
    }
  }, [canGoBack, fallbackUrl, router]);

  const handleClick = () => {
    if (canGoBack) {
      window.history.back();
    } else if (fallbackUrl) {
      router.push(fallbackUrl);
    } else {
      router.back();
    }
  };

  return (
    <IconButton
      onClick={handleClick}
      className={className}
      aria-label={t('ariaLabels.back')}
      sx={{ minWidth: 44, minHeight: 44 }}
    >
      <ArrowBackOutlined />
    </IconButton>
  );
};

export default BackButton;
