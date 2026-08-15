import React from 'react';
import { getServerAuthToken } from '../lib/auth/server-auth';
import FeedPageContent from './feed-page-content';
import { cachedSessionGroupedFeed } from '../lib/graphql/server-cached-client';
import type { SessionFeedResult } from '@boardsesh/shared-schema';
import { createPageMetadata } from '@/app/lib/seo/metadata';
import { getServerTranslation } from '@/app/lib/i18n/server';
import { getLocale } from '@/app/lib/i18n/get-locale';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { withSsrTimeout } from '@/app/lib/ssr-timeout';

export async function generateMetadata() {
  const { t, locale } = await getServerTranslation('feed');
  return createPageMetadata({
    title: t('metadata.feed.title'),
    description: t('metadata.feed.description'),
    path: '/feed',
    locale,
  });
}

type FeedTab = 'sessions' | 'proposals' | 'comments';
const VALID_TABS: FeedTab[] = ['sessions', 'proposals', 'comments'];

type FeedProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function FeedPage({ searchParams }: FeedProps) {
  const params = await searchParams;

  // Parse URL state
  const tab = (VALID_TABS.includes(params.tab as FeedTab) ? params.tab : 'sessions') as FeedTab;
  const boardUuid = typeof params.board === 'string' ? params.board : undefined;

  // Read auth cookie to determine if user is authenticated at SSR time
  const authToken = await getServerAuthToken();
  const isAuthenticatedSSR = !!authToken;

  // SSR: fetch the feed. The board filter strip that consumed `myBoards` came
  // out with the climbing UI, so there's nothing left to fetch alongside it.
  let initialFeedResult: SessionFeedResult | null = null;

  if (authToken) {
    initialFeedResult =
      tab === 'sessions'
        ? await withSsrTimeout(
            cachedSessionGroupedFeed(boardUuid, true).catch(() => null),
            null,
          )
        : null;
  } else if (tab === 'sessions') {
    initialFeedResult = await withSsrTimeout(
      cachedSessionGroupedFeed(boardUuid, false).catch(() => null),
      null,
    );
  }

  const locale = await getLocale();

  return (
    <I18nProvider locale={locale} namespaces={['feed']}>
      <FeedPageContent
        initialTab={tab}
        initialBoardUuid={boardUuid}
        initialFeedResult={initialFeedResult}
        isAuthenticatedSSR={isAuthenticatedSSR}
      />
    </I18nProvider>
  );
}
