'use client';

import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { persistShared } from '@/app/lib/react-query-persist-meta';
import { type Client, createGraphQLClient, subscribe } from '../graphql-queue/graphql-client';
import { getBackendWsUrl } from '@/app/lib/backend-url';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_NEW_CLIMB_FEED,
  NEW_CLIMB_CREATED_SUBSCRIPTION,
  type GetNewClimbFeedResponse,
  type GetNewClimbFeedVariables,
  type NewClimbCreatedSubscriptionPayload,
} from '@/app/lib/graphql/operations/new-climb-feed';
import type { NewClimbFeedItem as NewClimbFeedItemType, NewClimbFeedResult } from '@boardsesh/shared-schema';
import NewClimbFeedItem from './new-climb-feed-item';
import SubscribeButton from './subscribe-button';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useInfiniteScroll } from '@/app/hooks/use-infinite-scroll';

type NewClimbFeedProps = {
  boardType: string;
  layoutId: number;
  isAuthenticated: boolean;
  isSubscribed?: boolean;
};

const PAGE_SIZE = 20;

export default function NewClimbFeed({
  boardType,
  layoutId,
  isAuthenticated,
  isSubscribed = false,
}: NewClimbFeedProps) {
  const { t } = useTranslation('feed');
  const { token: wsAuthToken } = useWsAuthToken();
  const clientRef = useRef<Client | null>(null);
  const subscriptionRef = useRef<(() => void) | undefined>(undefined);
  const [subscribed, setSubscribed] = useState(isSubscribed);
  const queryClient = useQueryClient();

  const queryKey = useMemo(() => ['newClimbFeed', boardType, layoutId] as const, [boardType, layoutId]);

  const ensureWsClient = useCallback(() => {
    if (!clientRef.current) {
      clientRef.current = createGraphQLClient({
        url: getBackendWsUrl()!,
        authToken: wsAuthToken,
      });
    }
    return clientRef.current;
  }, [wsAuthToken]);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, error } = useInfiniteQuery<
    NewClimbFeedResult,
    Error
  >({
    queryKey,
    queryFn: async ({ pageParam }) => {
      const client = createGraphQLHttpClient(wsAuthToken);
      const variables: GetNewClimbFeedVariables = {
        input: { boardType, layoutId, limit: PAGE_SIZE, offset: pageParam as number },
      };
      const response = await client.request<GetNewClimbFeedResponse>(GET_NEW_CLIMB_FEED, variables);
      return response.newClimbFeed;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      if (!lastPage.hasMore) return undefined;
      return (lastPageParam as number) + lastPage.items.length;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnMount: 'always',
    meta: persistShared,
  });

  const items: NewClimbFeedItemType[] = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);

  const { sentinelRef } = useInfiniteScroll({
    onLoadMore: fetchNextPage,
    hasMore: hasNextPage ?? false,
    isFetching: isFetchingNextPage,
  });

  // Real-time subscription for new climbs
  useEffect(() => {
    const client = ensureWsClient();
    if (subscriptionRef.current) {
      subscriptionRef.current();
    }
    subscriptionRef.current = subscribe<NewClimbCreatedSubscriptionPayload>(
      client,
      { query: NEW_CLIMB_CREATED_SUBSCRIPTION, variables: { boardType, layoutId } },
      {
        next: (subData) => {
          const newItem = subData.newClimbCreated.climb;
          queryClient.setQueryData<InfiniteData<NewClimbFeedResult>>(queryKey, (old) => {
            if (!old) return old;
            const firstPage = old.pages[0];
            if (firstPage.items.some((i) => i.uuid === newItem.uuid)) return old;
            return {
              ...old,
              pages: [
                {
                  ...firstPage,
                  items: [newItem, ...firstPage.items].slice(0, PAGE_SIZE),
                  totalCount: firstPage.totalCount + 1,
                },
                ...old.pages.slice(1),
              ],
            };
          });
        },
        error: (err) => console.error('New climb subscription error', err),
        complete: () => {},
      },
    );

    return () => {
      subscriptionRef.current?.();
      subscriptionRef.current = undefined;
    };
  }, [boardType, layoutId, ensureWsClient, queryClient, queryKey]); // queryKey uses boardType+layoutId which are already deps

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
        <Typography variant="h6" fontWeight={700}>
          {t('newClimbFeed.title')}
        </Typography>
        <SubscribeButton
          boardType={boardType}
          layoutId={layoutId}
          isSubscribed={subscribed}
          disabled={!isAuthenticated}
          onSubscriptionChange={setSubscribed}
        />
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {t('newClimbFeed.errorLoad')}
        </Alert>
      )}

      {items.map((item) => (
        <NewClimbFeedItem key={item.uuid} item={item} />
      ))}

      {isLoading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
          <CircularProgress size={24} />
        </Box>
      )}

      {!isLoading && items.length > 0 && (
        <Box ref={sentinelRef} sx={{ display: 'flex', justifyContent: 'center', py: 2, minHeight: 20 }}>
          {isFetchingNextPage && <CircularProgress size={24} />}
        </Box>
      )}

      {!isLoading && items.length === 0 && !error && (
        <Typography variant="body2" color="text.secondary">
          {t('newClimbFeed.empty')}
        </Typography>
      )}
    </Box>
  );
}
