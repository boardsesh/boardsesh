'use client';

import React, { useState, useMemo, useCallback } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  GET_SETTER_CLIMBS_FULL,
  type GetSetterClimbsFullQueryVariables,
  type GetSetterClimbsFullQueryResponse,
} from '@boardsesh/graphql/operations';
import { getDefaultAngleForBoard } from '@/app/lib/board-config-for-playlist';
import type { UserBoard } from '@boardsesh/shared-schema';
import type { Climb } from '@/app/lib/types';
import MultiboardClimbList, { type SortBy } from './multiboard-climb-list';

type SetterClimbListProps = {
  username: string;
  boardTypes?: string[];
  authToken?: string | null;
};

export default function SetterClimbList({ username, boardTypes, authToken }: SetterClimbListProps) {
  const [selectedBoard] = useState<UserBoard | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>('popular');

  const { data, fetchNextPage, hasNextPage, isFetching, isLoading } = useInfiniteQuery({
    queryKey: ['setterClimbs', username, selectedBoard?.uuid ?? 'all', sortBy],
    queryFn: async ({ pageParam }) => {
      const client = createGraphQLHttpClient(authToken ?? null);
      const variables: GetSetterClimbsFullQueryVariables = {
        input: {
          username,
          sortBy,
          limit: 20,
          offset: pageParam,
        },
      };

      if (selectedBoard) {
        variables.input.boardType = selectedBoard.boardType;
        variables.input.layoutId = selectedBoard.layoutId;
        variables.input.sizeId = selectedBoard.sizeId;
        variables.input.setIds = selectedBoard.setIds;
        variables.input.angle = selectedBoard.angle ?? getDefaultAngleForBoard(selectedBoard.boardType);
      }

      const response = await client.request<GetSetterClimbsFullQueryResponse, GetSetterClimbsFullQueryVariables>(
        GET_SETTER_CLIMBS_FULL,
        variables,
      );
      return response.setterClimbsFull;
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
      selectedBoard={selectedBoard}
      showSortToggle
      sortBy={sortBy}
      onSortChange={setSortBy}
      totalCount={totalCount}
      fallbackBoardTypes={boardTypes}
    />
  );
}
