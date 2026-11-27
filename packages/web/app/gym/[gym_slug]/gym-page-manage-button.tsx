'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import Button from '@mui/material/Button';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import LocaleLink from '@/app/components/i18n/locale-link';

/**
 * Client island: the "Manage gym" entry on the public gym page. The server only
 * renders this for viewers who can edit the gym.
 */
export default function GymPageManageButton({ gymSlug }: { gymSlug: string }) {
  const { t } = useTranslation('kiosk');
  return (
    <Button
      component={LocaleLink}
      href={`/gym/${gymSlug}/manage`}
      variant="outlined"
      startIcon={<SettingsOutlined />}
      sx={{ textTransform: 'none' }}
    >
      {t('gymPage.manageGym')}
    </Button>
  );
}
