'use client';

import React, { useCallback } from 'react';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import { useTranslation } from 'react-i18next';
import { useLocaleRouter, usePathnameWithoutLocale } from '@/app/lib/i18n/use-locale-router';

type YouTab = 'progress' | 'sessions';

export default function YouTabBar() {
  const { t } = useTranslation('you');
  const router = useLocaleRouter();
  const pathname = usePathnameWithoutLocale();

  const activeTab: YouTab = pathname === '/you/sessions' ? 'sessions' : 'progress';

  const handleTabChange = useCallback(
    (_: React.SyntheticEvent, value: YouTab) => {
      const path = value === 'progress' ? '/you' : `/you/${value}`;
      router.push(path, { scroll: false });
    },
    [router],
  );

  return (
    <Tabs value={activeTab} onChange={handleTabChange} variant="fullWidth" sx={{ mb: 2 }}>
      <Tab label={t('tabs.progress')} value="progress" />
      <Tab label={t('tabs.sessions')} value="sessions" />
    </Tabs>
  );
}
