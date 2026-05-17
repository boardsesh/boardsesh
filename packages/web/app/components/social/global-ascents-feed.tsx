'use client';

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import PublicOutlined from '@mui/icons-material/PublicOutlined';
import { useInfiniteQuery } from '@tanstack/react-query';
import { persistShared } from '@/app/lib/react-query-persist-meta';
import { EmptyState } from '@/app/components/ui/empty-state';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_GLOBAL_ASCENTS_FEED,
  type GetGlobalAscentsFeedQueryVariables,
  type GetGlobalAscentsFeedQueryResponse,
} from '@/app/lib/graphql/operations';
import type { FollowingAscentFeedItem } from '@boardsesh/shared-schema';
import { VoteSummaryProvider } from '@/app/components/social/vote-summary-context';
import SocialFeedItem from '@/app/components/activity-feed/social-feed-item';
import { useInfiniteScroll } from '@/app/hooks/use-infinite-scroll';

export default function GlobalAscentsFeed() {
  const { t } = useTranslation('feed');
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery({
    queryKey: ['globalAscentsFeed'],
    queryFn: async ({ pageParam }) => {
      const client = createGraphQLHttpClient(null);
      const response = await client.request<GetGlobalAscentsFeedQueryResponse, GetGlobalAscentsFeedQueryVariables>(
        GET_GLOBAL_ASCENTS_FEED,
        { input: { limit: 20, offset: pageParam } },
      );
      return response.globalAscentsFeed;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      if (!lastPage.hasMore) return undefined;
      return lastPageParam + lastPage.items.length;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnMount: 'always',
    meta: persistShared,
  });

  const items: FollowingAscentFeedItem[] = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);

  const tickUuids = useMemo(() => items.map((item) => item.uuid), [items]);

  const { sentinelRef } = useInfiniteScroll({
    onLoadMore: fetchNextPage,
    hasMore: hasNextPage ?? false,
    isFetching: isFetchingNextPage,
  });

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (items.length === 0) {
    return <EmptyState icon={<PublicOutlined fontSize="inherit" />} description={t('emptyStates.noRecentActivity')} />;
  }

  return (
    <VoteSummaryProvider entityType="tick" entityIds={tickUuids}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {items.map((item) => (
          <SocialFeedItem key={item.uuid} item={item} showUserHeader />
        ))}
        <Box ref={sentinelRef} sx={{ display: 'flex', justifyContent: 'center', py: 2, minHeight: 20 }}>
          {isFetchingNextPage && <CircularProgress size={24} />}
        </Box>
      </Box>
    </VoteSummaryProvider>
  );
}
