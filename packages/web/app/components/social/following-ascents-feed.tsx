'use client';

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import MuiButton from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import PersonSearchOutlined from '@mui/icons-material/PersonSearchOutlined';
import { useInfiniteQuery } from '@tanstack/react-query';
import { persistUser } from '@/app/lib/react-query-persist-meta';
import { EmptyState } from '@/app/components/ui/empty-state';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_FOLLOWING_ASCENTS_FEED,
  type GetFollowingAscentsFeedQueryVariables,
  type GetFollowingAscentsFeedQueryResponse,
} from '@/app/lib/graphql/operations';
import type { FollowingAscentFeedItem } from '@boardsesh/shared-schema';
import { VoteSummaryProvider } from '@/app/components/social/vote-summary-context';
import SocialFeedItem from '@/app/components/activity-feed/social-feed-item';
import { useInfiniteScroll } from '@/app/hooks/use-infinite-scroll';

type FollowingAscentsFeedProps = {
  onFindClimbers?: () => void;
};

export default function FollowingAscentsFeed({ onFindClimbers }: FollowingAscentsFeedProps) {
  const { t } = useTranslation('feed');
  const { token, isAuthenticated, isLoading: authLoading } = useWsAuthToken();

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery({
    queryKey: ['followingAscentsFeed', token],
    queryFn: async ({ pageParam }) => {
      const client = createGraphQLHttpClient(token);
      const response = await client.request<
        GetFollowingAscentsFeedQueryResponse,
        GetFollowingAscentsFeedQueryVariables
      >(GET_FOLLOWING_ASCENTS_FEED, { input: { limit: 20, offset: pageParam } });
      return response.followingAscentsFeed;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      if (!lastPage.hasMore) return undefined;
      return lastPageParam + lastPage.items.length;
    },
    enabled: isAuthenticated && !!token,
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnMount: 'always',
    meta: persistUser,
  });

  const items: FollowingAscentFeedItem[] = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);

  const tickUuids = useMemo(() => items.map((item) => item.uuid), [items]);

  const { sentinelRef } = useInfiniteScroll({
    onLoadMore: fetchNextPage,
    hasMore: hasNextPage ?? false,
    isFetching: isFetchingNextPage,
  });

  if (authLoading || isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState icon={<PersonSearchOutlined fontSize="inherit" />} description={t('emptyStates.followClimbers')}>
        {onFindClimbers && (
          <MuiButton variant="contained" onClick={onFindClimbers}>
            {t('emptyStates.findClimbers')}
          </MuiButton>
        )}
      </EmptyState>
    );
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
