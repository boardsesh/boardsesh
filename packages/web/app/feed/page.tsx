import React from 'react';
import { getServerAuthToken } from '../lib/auth/server-auth';
import FeedPageContent from './feed-page-content';
import { cachedSessionGroupedFeed, serverMyBoards } from '../lib/graphql/server-cached-client';
import type { SessionFeedResult } from '@boardsesh/shared-schema';
import { createNoIndexMetadata } from '@/app/lib/seo/metadata';

export const metadata = createNoIndexMetadata({
  title: 'Activity Feed',
  description: 'View climbing activity from people you follow.',
  path: '/feed',
});

type FeedTab = 'sessions' | 'proposals' | 'comments';
const VALID_TABS: FeedTab[] = ['sessions', 'proposals', 'comments'];

type FeedProps = {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default async function FeedPage({ searchParams }: FeedProps) {
  const params = await searchParams;

  // Parse URL state
  const tab = (VALID_TABS.includes(params.tab as FeedTab) ? params.tab : 'sessions') as FeedTab;
  const boardUuid = typeof params.board === 'string' ? params.board : undefined;

  // Read auth cookie to determine if user is authenticated at SSR time
  const authToken = await getServerAuthToken();
  const isAuthenticatedSSR = !!authToken;

  // SSR: fetch boards + feed in parallel
  let initialFeedResult: SessionFeedResult | null = null;
  let initialMyBoards: import('@boardsesh/shared-schema').UserBoard[] | null = null;

  if (authToken) {
    const feedPromise = tab === 'sessions'
      ? cachedSessionGroupedFeed(boardUuid, true).catch(() => null)
      : Promise.resolve(null);
    const boardsPromise = serverMyBoards(authToken);

    const [feedResult, boardsResult] = await Promise.all([feedPromise, boardsPromise]);
    initialFeedResult = feedResult;
    initialMyBoards = boardsResult;
  } else if (tab === 'sessions') {
    try {
      initialFeedResult = await cachedSessionGroupedFeed(boardUuid, false);
    } catch {
      // Feed fetch failed, client will retry
    }
  }

  return (
    <FeedPageContent
      initialTab={tab}
      initialBoardUuid={boardUuid}
      initialFeedResult={initialFeedResult}
      isAuthenticatedSSR={isAuthenticatedSSR}
      initialMyBoards={initialMyBoards}
    />
  );
}
