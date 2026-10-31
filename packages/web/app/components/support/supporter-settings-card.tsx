'use client';

import React from 'react';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import { useTranslation } from 'react-i18next';
import SupporterPanel from './supporter-panel';

/** The `/settings` home of public supporter credit and "Already gave? Link it". */
export default function SupporterSettingsCard() {
  const { t } = useTranslation('settings');
  return (
    <Card data-testid="supporter-settings-card">
      <CardContent>
        <Typography variant="h5">{t('supporter.title')}</Typography>
        <Typography variant="body2" component="p" color="text.secondary" sx={{ my: 2 }}>
          {t('supporter.intro')}
        </Typography>
        <SupporterPanel variant="settings" />
      </CardContent>
    </Card>
  );
}
