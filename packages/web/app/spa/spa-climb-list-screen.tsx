'use client';

import React, { useState } from 'react';
import Box from '@mui/material/Box';
import { useQueueDataFetching } from '@/app/components/queue-control/hooks/use-queue-data-fetching';
import ClimbsList from '@/app/components/board-page/climbs-list';
import AccordionSearchForm from '@/app/components/search-drawer/accordion-search-form';
import { urlParamsToSearchParams, constructBoardSlugViewUrl } from '@/app/lib/url-utils';
import type { Climb } from '@/app/lib/types';
import { SpaUiSearchParamsProvider } from './spa-ui-search-params-provider';
import type { SpaBoard } from './hooks/use-spa-board';

type SpaClimbListScreenProps = {
  boardSlug: string;
  angle: number;
  spaBoard: SpaBoard;
  searchParams: URLSearchParams;
  navigate: (path: string, options?: { replace?: boolean }) => void;
};

/** Climbs list + filters screen. Filter state lives entirely in the URL
 * (see spa-ui-search-params-provider.tsx) — no queue, no party mode. */
export function SpaClimbListScreen({ boardSlug, angle, spaBoard, searchParams, navigate }: SpaClimbListScreenProps) {
  const { boardDetails, parsedParams } = spaBoard;
  const [hasDoneFirstFetch, setHasDoneFirstFetchState] = useState(false);
  const setHasDoneFirstFetch = () => setHasDoneFirstFetchState(true);

  const filters = urlParamsToSearchParams(searchParams);

  const { climbSearchResults, hasMoreResults, isFetchingClimbs, fetchMoreClimbs } = useQueueDataFetching({
    searchParams: filters,
    countSearchParams: filters,
    queue: [],
    parsedParams,
    hasDoneFirstFetch,
    setHasDoneFirstFetch,
  });

  const handleClimbSelect = (climb: Climb) => {
    navigate(`/spa${constructBoardSlugViewUrl(boardSlug, angle, climb.uuid, climb.name)}`);
  };

  return (
    <SpaUiSearchParamsProvider boardSlug={boardSlug} angle={angle} searchParams={searchParams} navigate={navigate}>
      <Box sx={{ p: 2 }}>
        <AccordionSearchForm boardDetails={boardDetails} />
      </Box>
      <ClimbsList
        boardDetails={boardDetails}
        climbs={climbSearchResults ?? []}
        isFetching={isFetchingClimbs}
        hasMore={hasMoreResults}
        onClimbSelect={handleClimbSelect}
        onLoadMore={fetchMoreClimbs}
        showBottomSpacer
      />
    </SpaUiSearchParamsProvider>
  );
}
