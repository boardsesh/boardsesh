import React from 'react';
import AppGuidePage from '@/app/components/app-guides/app-guide-page';
import { getAppGuideMetadata, loadAppGuideCopy } from '@/app/components/app-guides/app-guide-copy';
import { APP_GUIDE_HUB } from '@/app/lib/seo/app-guides';

export function generateMetadata() {
  return getAppGuideMetadata(APP_GUIDE_HUB);
}

export default async function BoardAppsPage() {
  const copy = await loadAppGuideCopy();
  return <AppGuidePage guide={APP_GUIDE_HUB} {...copy} />;
}
