'use client';

import React, { useCallback, useEffect } from 'react';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import { useTranslation } from 'react-i18next';
import { useLocaleRouter, usePathnameWithoutLocale } from '@/app/lib/i18n/use-locale-router';
import { setPreference } from '@/app/lib/user-preferences-db';

type YouTab = 'progress' | 'sessions' | 'logbook';

export default function YouTabBar() {
  const { t } = useTranslation('you');
  const router = useLocaleRouter();
  const pathname = usePathnameWithoutLocale();

  let activeTab: YouTab;
  if (pathname === '/you/sessions') {
    activeTab = 'sessions';
  } else if (pathname === '/you/logbook') {
    activeTab = 'logbook';
  } else {
    activeTab = 'progress';
  }

  // Remember the last /you sub-tab the user was on so the bottom tab bar's
  // "you" link can resume them where they left off.
  useEffect(() => {
    void setPreference('youLastTab', activeTab);
  }, [activeTab]);

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
      <Tab label={t('tabs.logbook')} value="logbook" />
    </Tabs>
  );
}
