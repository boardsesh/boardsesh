'use client';
import React, { createContext, useContext, useState } from 'react';
import { SearchRequestPagination } from '@/lib/types';
import { useDebouncedCallback } from 'use-debounce';
import { track } from '@vercel/analytics';
import { useQueueActions, useSearchData } from '../graphql-queue';
import { DEFAULT_SEARCH_PARAMS } from '@/app/lib/url-utils';

interface UISearchParamsContextType {
  uiSearchParams: SearchRequestPagination;
  updateFilters: (newFilters: Partial<SearchRequestPagination>, instant?: boolean) => void;
  clearClimbSearchParams: () => void;
}

const UISearchParamsContext = createContext<UISearchParamsContextType | undefined>(undefined);

/**
 * UI interacting with the search paramaters should always go through the ui-search-params-provider
 * and never directly through the queue-provider. The ui provider implements UI concerns.
 * For example it maintains a copy of the search params so that the UI can update without hammering the rest-api.
 * Updating the state that affects the actual search is then debounced.
 *
 */
export const UISearchParamsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { climbSearchParams } = useSearchData();
  const { setClimbSearchParams, setCountSearchParams } = useQueueActions();
  const [uiSearchParams, setUISearchParams] = useState<SearchRequestPagination>(climbSearchParams);

  const debouncedUpdate = useDebouncedCallback(() => {
    // Track search performed
    const activeFilters = [];
    if (uiSearchParams.name) activeFilters.push('climbName');
    if (uiSearchParams.minGrade || uiSearchParams.maxGrade) activeFilters.push('gradeRange');
    if (uiSearchParams.minAscents) activeFilters.push('minAscents');
    if (uiSearchParams.minRating) activeFilters.push('minRating');
    if (uiSearchParams.onlyClassics) activeFilters.push('classics');
    if (uiSearchParams.gradeAccuracy) activeFilters.push('gradeAccuracy');
    if (uiSearchParams.settername.length > 0) activeFilters.push('setter');
    if (uiSearchParams.holdsFilter && Object.entries(uiSearchParams.holdsFilter).length > 0)
      activeFilters.push('holds');
    if (uiSearchParams.onlyTallClimbs) activeFilters.push('onlyTallClimbs');
    if (uiSearchParams.hideAttempted) activeFilters.push('hideAttempted');
    if (uiSearchParams.hideCompleted) activeFilters.push('hideCompleted');
    if (uiSearchParams.showOnlyAttempted) activeFilters.push('showOnlyAttempted');
    if (uiSearchParams.showOnlyCompleted) activeFilters.push('showOnlyCompleted');
    if (uiSearchParams.onlyDrafts) activeFilters.push('onlyDrafts');

    if (activeFilters.length > 0) {
      track('Climb Search Performed', {
        searchType: 'filters',
        activeFiltersCount: activeFilters.length,
      });
    }

    setClimbSearchParams(uiSearchParams);
    setCountSearchParams(uiSearchParams);
  }, 500);

  const updateFilters = (newFilters: Partial<SearchRequestPagination>, instant?: boolean) => {
    const updatedFilters = {
      ...uiSearchParams,
      ...newFilters,
      page: 0,
    };

    setUISearchParams(updatedFilters);

    if (instant) {
      setClimbSearchParams(updatedFilters);
      setCountSearchParams(updatedFilters);
    } else {
      debouncedUpdate();
    }
  };

  const clearClimbSearchParams = () => updateFilters(DEFAULT_SEARCH_PARAMS, true);

  return (
    <UISearchParamsContext.Provider value={{ uiSearchParams, updateFilters, clearClimbSearchParams }}>
      {children}
    </UISearchParamsContext.Provider>
  );
};

// Custom hook for consuming the context
export const useUISearchParams = () => {
  const context = useContext(UISearchParamsContext);
  if (!context) {
    throw new Error('useUISearchParams must be used within a SearchParamsProvider');
  }
  return context;
};
