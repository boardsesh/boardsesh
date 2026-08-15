'use client';

import React, { useState, useMemo, useCallback } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_USER_CLIMBS,
  type GetUserClimbsQueryVariables,
  type GetUserClimbsQueryResponse,
} from '@boardsesh/graphql/operations';
import type { Climb } from '@/app/lib/types';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import MultiboardClimbList, { type SortBy } from './multiboard-climb-list';

type UserClimbListProps = {
  userId: string;
};

export default function UserClimbList({ userId }: UserClimbListProps) {
  const [sortBy, setSortBy] = useState<SortBy>('popular');
  const { token } = useWsAuthToken();

  const { data, fetchNextPage, hasNextPage, isFetching, isLoading } = useInfiniteQuery({
    queryKey: ['userClimbs', userId, sortBy],
    queryFn: async ({ pageParam }) => {
      const client = createGraphQLHttpClient(token ?? null);
      const variables: GetUserClimbsQueryVariables = {
        input: {
          userId,
          sortBy,
          limit: 20,
          offset: pageParam,
        },
      };

      const response = await client.request<GetUserClimbsQueryResponse, GetUserClimbsQueryVariables>(
        GET_USER_CLIMBS,
        variables,
      );
      return response.userClimbs;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      if (!lastPage.hasMore) return undefined;
      return lastPageParam + lastPage.climbs.length;
    },
    staleTime: 60 * 1000,
  });

  const climbs: Climb[] = useMemo(() => data?.pages.flatMap((p) => p.climbs) ?? [], [data]);
  const totalCount = data?.pages[0]?.totalCount ?? 0;

  const handleLoadMore = useCallback(() => {
    if (hasNextPage) {
      void fetchNextPage();
    }
  }, [hasNextPage, fetchNextPage]);

  return (
    <MultiboardClimbList
      climbs={climbs}
      isFetching={isFetching}
      isLoading={isLoading}
      hasMore={hasNextPage ?? false}
      onLoadMore={handleLoadMore}
      selectedBoard={null}
      showSortToggle
      sortBy={sortBy}
      onSortChange={setSortBy}
      totalCount={totalCount}
    />
  );
}
