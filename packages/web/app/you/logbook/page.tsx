import React, { Suspense } from 'react';
import { redirect } from 'next/navigation';
import LogbookFeed from '@/app/components/library/logbook-feed';
import LogbookLoading from './loading';
import { cachedUserProfileStats } from '@/app/lib/graphql/server-cached-client';
import { getYouSession } from '../you-auth';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('you');
  return createNoIndexMetadata({
    title: t('metadata.logbook.title'),
    description: t('metadata.logbook.description'),
    path: '/you/logbook',
    locale,
  });
}

export default async function YouLogbookPage() {
  const session = await getYouSession();
  if (!session?.user?.id) {
    redirect('/');
  }
  const userId = session.user.id;
  // The logbook page only consumes `layoutStats` for the layout filter tabs —
  // 5-min cache staleness on which boards/layouts a user has ticked is fine.
  // The `/you` dashboard keeps the uncached path because its charts must
  // reflect a just-logged tick immediately.
  const profileStats = await cachedUserProfileStats(userId);
  const layoutStats = profileStats?.layoutStats ?? [];

  // Per-element protection for translator-DOM crashes (issue #2064) lives on
  // the LogbookFeedItem itself (climb-name span). The error boundary
  // auto-recovers from any residual NotFoundError.
  return (
    <Suspense fallback={<LogbookLoading />}>
      <LogbookFeed layoutStats={layoutStats} loadingLayoutStats={false} />
    </Suspense>
  );
}
