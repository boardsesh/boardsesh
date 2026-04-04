import React from 'react';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import SettingsPageContent from './settings-page-content';

export const metadata = createNoIndexMetadata({
  title: 'Settings',
  description: 'Manage your Boardsesh account settings',
  path: '/settings',
});

export default function SettingsPage() {
  return <SettingsPageContent />;
}
