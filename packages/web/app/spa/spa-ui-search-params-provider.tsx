'use client';

import React, { useRef, useState } from 'react';
import { useDebouncedCallback } from 'use-debounce';
import type { SearchRequestPagination } from '@/app/lib/types';
import {
  DEFAULT_SEARCH_PARAMS,
  searchParamsToUrlParams,
  urlParamsToSearchParams,
  constructBoardSlugListUrl,
} from '@/app/lib/url-utils';
import { UISearchParamsContext } from '@/app/components/queue-control/ui-searchparams-provider';

type SpaUiSearchParamsProviderProps = {
  boardSlug: string;
  angle: number;
  searchParams: URLSearchParams;
  navigate: (path: string, options?: { replace?: boolean }) => void;
  children: React.ReactNode;
};

/**
 * URL-backed drop-in replacement for `UISearchParamsProvider` — same context,
 * same debounced-commit shape, but commits land in the address bar (via the
 * SPA router) instead of QueueContext's `setClimbSearchParams`. Lets
 * `AccordionSearchForm`/`ClimbSearchForm` render unmodified inside the SPA.
 */
export function SpaUiSearchParamsProvider({
  boardSlug,
  angle,
  searchParams,
  navigate,
  children,
}: SpaUiSearchParamsProviderProps) {
  const [uiSearchParams, setUiSearchParams] = useState<SearchRequestPagination>(() =>
    urlParamsToSearchParams(searchParams),
  );

  // Re-sync local UI state when the URL changed for a reason other than our
  // own commit below (browser back/forward, a fresh /list load).
  const lastSearchStringRef = useRef(searchParams.toString());
  if (searchParams.toString() !== lastSearchStringRef.current) {
    lastSearchStringRef.current = searchParams.toString();
    setUiSearchParams(urlParamsToSearchParams(searchParams));
  }

  const commit = (next: SearchRequestPagination) => {
    const query = searchParamsToUrlParams(next).toString();
    lastSearchStringRef.current = query;
    const path = `/spa${constructBoardSlugListUrl(boardSlug, angle)}${query ? `?${query}` : ''}`;
    navigate(path, { replace: true });
  };

  const debouncedCommit = useDebouncedCallback((next: SearchRequestPagination) => commit(next), 500);

  const updateFilters = (newFilters: Partial<SearchRequestPagination>, instant?: boolean) => {
    // Drop undefined values so a Partial can't overwrite a defined field with
    // `undefined` (mirrors UISearchParamsProvider's own guard).
    const sanitized = Object.fromEntries(
      Object.entries(newFilters).filter(([, value]) => value !== undefined),
    ) as Partial<SearchRequestPagination>;
    const updated: SearchRequestPagination = { ...uiSearchParams, ...sanitized, page: 0 };
    setUiSearchParams(updated);

    if (instant) {
      commit(updated);
    } else {
      debouncedCommit(updated);
    }
  };

  const clearClimbSearchParams = () => updateFilters(DEFAULT_SEARCH_PARAMS, true);

  return (
    <UISearchParamsContext.Provider value={{ uiSearchParams, updateFilters, clearClimbSearchParams }}>
      {children}
    </UISearchParamsContext.Provider>
  );
}
