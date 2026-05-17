'use client';

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import MuiButton from '@mui/material/Button';
import MuiAlert from '@mui/material/Alert';
import PersonSearchOutlined from '@mui/icons-material/PersonSearchOutlined';
import PublicOutlined from '@mui/icons-material/PublicOutlined';
import ErrorOutline from '@mui/icons-material/ErrorOutline';
import { useInfiniteQuery } from '@tanstack/react-query';
import { persistUser } from '@/app/lib/react-query-persist-meta';
import { EmptyState } from '@/app/components/ui/empty-state';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { GET_SESSION_GROUPED_FEED, type GetSessionGroupedFeedQueryResponse } from '@/app/lib/graphql/operations';
import type { SessionFeedItem, SessionFeedResult } from '@boardsesh/shared-schema';
import { VoteSummaryProvider } from '@/app/components/social/vote-summary-context';
import SessionFeedCard from './session-feed-card';
import FeedItemSkeleton from './feed-item-skeleton';
import { useInfiniteScroll } from '@/app/hooks/use-infinite-scroll';

/** Page type for the session-grouped feed */
export type SessionFeedPage = SessionFeedResult;

type ActivityFeedProps = {
  isAuthenticated: boolean;
  boardUuid?: string | null;
  /** Filter sessions by a specific user */
  userId?: string | null;
  onFindClimbers?: () => void;
  /** SSR-provided initial session feed result */
  initialFeedResult?: SessionFeedResult | null;
};

export default function ActivityFeed({
  isAuthenticated,
  boardUuid,
  userId,
  onFindClimbers,
  initialFeedResult,
}: ActivityFeedProps) {
  const { t } = useTranslation('feed');
  const { token, isLoading: authLoading, error: authError } = useWsAuthToken();

  const hasInitialData = !!initialFeedResult && initialFeedResult.sessions.length > 0;

  const queryKey = ['sessionFeed', boardUuid, userId] as const;

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, error, refetch } = useInfiniteQuery<
    SessionFeedPage,
    Error
  >({
    queryKey,
    queryFn: async ({ pageParam }) => {
      const client = createGraphQLHttpClient(isAuthenticated ? token : null);
      const input = {
        limit: 20,
        cursor: pageParam as string | null,
        boardUuid: boardUuid || undefined,
        userId: userId || undefined,
      };

      const response = await client.request<GetSessionGroupedFeedQueryResponse>(GET_SESSION_GROUPED_FEED, { input });
      return response.sessionGroupedFeed;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => {
      if (!lastPage.hasMore) return undefined;
      return lastPage.cursor ?? undefined;
    },
    enabled: isAuthenticated ? !!token : true,
    staleTime: isAuthenticated ? 5 * 60 * 1000 : 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnMount: 'always',
    // Only persist the signed-in viewer's feed; public reads can vary by viewer
    // identity (block lists etc.) and aren't worth bothering with IDB for.
    meta: isAuthenticated ? persistUser : undefined,
    ...(hasInitialData
      ? {
          initialData: {
            pages: [initialFeedResult],
            pageParams: [null],
          },
          initialDataUpdatedAt: Date.now(),
        }
      : {}),
  });

  const sessions: SessionFeedItem[] = useMemo(() => data?.pages.flatMap((p) => p.sessions) ?? [], [data]);

  const sessionIds = useMemo(() => sessions.map((s) => s.sessionId), [sessions]);

  const { sentinelRef } = useInfiniteScroll({
    onLoadMore: fetchNextPage,
    hasMore: hasNextPage ?? false,
    isFetching: isFetchingNextPage,
  });

  if ((authLoading || isLoading) && sessions.length === 0) {
    return (
      <Box data-testid="activity-feed" sx={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <FeedItemSkeleton />
        <FeedItemSkeleton />
        <FeedItemSkeleton />
      </Box>
    );
  }

  let emptyStateContent: React.ReactNode = null;
  if (isAuthenticated) {
    emptyStateContent = (
      <EmptyState icon={<PersonSearchOutlined fontSize="inherit" />} description={t('emptyStates.followClimbers')}>
        {onFindClimbers && (
          <MuiButton variant="contained" onClick={onFindClimbers}>
            {t('emptyStates.findClimbers')}
          </MuiButton>
        )}
      </EmptyState>
    );
  } else {
    emptyStateContent = (
      <EmptyState icon={<PublicOutlined fontSize="inherit" />} description={t('emptyStates.noRecentActivity')} />
    );
  }

  return (
    <Box data-testid="activity-feed" sx={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {!isAuthenticated && (
        <MuiAlert severity="info" sx={{ mb: 1 }}>
          {t('activityFeed.signInPrompt')}
        </MuiAlert>
      )}

      {isAuthenticated && !authLoading && !token && (
        <MuiAlert severity="warning" sx={{ mb: 1 }}>
          {authError
            ? 'Signed in, but Boardsesh could not load authenticated session data on this device.'
            : 'Signed in, but Boardsesh could not access authenticated session data on this device.'}
        </MuiAlert>
      )}

      {error && (
        <EmptyState icon={<ErrorOutline fontSize="inherit" />} description={t('errors.loadFeed')}>
          <MuiButton variant="contained" onClick={() => refetch()}>
            {t('common:actions.retry')}
          </MuiButton>
        </EmptyState>
      )}

      {!error && sessions.length === 0 ? (
        emptyStateContent
      ) : (
        <VoteSummaryProvider entityType="session" entityIds={sessionIds}>
          {sessions.map((session) => (
            <SessionFeedCard key={session.sessionId} session={session} />
          ))}
          <Box
            ref={sentinelRef}
            data-testid="activity-feed-sentinel"
            sx={{ display: 'flex', flexDirection: 'column', gap: '12px', py: 2, minHeight: 20 }}
          >
            {isFetchingNextPage && (
              <>
                <FeedItemSkeleton />
                <FeedItemSkeleton />
              </>
            )}
          </Box>
        </VoteSummaryProvider>
      )}
    </Box>
  );
}
