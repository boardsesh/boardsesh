'use client';
import React, { createContext, useContext, useState } from 'react';
import type { SearchRequestPagination } from '@/lib/types';
import { useDebouncedCallback } from 'use-debounce';
import { track } from '@/app/lib/analytics';
import { useQueueActions, useSearchData } from '../graphql-queue';
import { DEFAULT_SEARCH_PARAMS } from '@/app/lib/url-utils';
import { incrementSearches, maybeFireFeedbackPromptEvent } from '@/app/lib/feedback-prompt-db';

type UISearchParamsContextType = {
  uiSearchParams: SearchRequestPagination;
  updateFilters: (newFilters: Partial<SearchRequestPagination>, instant?: boolean) => void;
  clearClimbSearchParams: () => void;
};

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
    if (uiSearchParams.projectsOnly) activeFilters.push('projectsOnly');
    if (uiSearchParams.zoneBox) activeFilters.push('zone');

    if (activeFilters.length > 0) {
      void incrementSearches().then(maybeFireFeedbackPromptEvent);
      track('Climb Search Performed', {
        searchType: 'filters',
        activeFiltersCount: activeFilters.length,
        sortBy: uiSearchParams.sortBy,
        sortOrder: uiSearchParams.sortOrder,
        hasName: Boolean(uiSearchParams.name),
        minGrade: uiSearchParams.minGrade,
        maxGrade: uiSearchParams.maxGrade,
        minAscents: uiSearchParams.minAscents,
        minRating: uiSearchParams.minRating,
        gradeAccuracy: uiSearchParams.gradeAccuracy,
        onlyClassics: uiSearchParams.onlyClassics,
        projectsOnly: uiSearchParams.projectsOnly,
        establishedOnly: uiSearchParams.minAscents >= 2 && !uiSearchParams.projectsOnly,
        onlyTallClimbs: uiSearchParams.onlyTallClimbs,
        onlyDrafts: uiSearchParams.onlyDrafts,
        hideAttempted: uiSearchParams.hideAttempted,
        hideCompleted: uiSearchParams.hideCompleted,
        showOnlyAttempted: uiSearchParams.showOnlyAttempted,
        showOnlyCompleted: uiSearchParams.showOnlyCompleted,
        holdsCount: Object.keys(uiSearchParams.holdsFilter || {}).length,
        setterCount: uiSearchParams.settername.length,
      });
    }

    setClimbSearchParams(uiSearchParams);
    setCountSearchParams(uiSearchParams);
  }, 500);

  const updateFilters = (newFilters: Partial<SearchRequestPagination>, instant?: boolean) => {
    // Drop undefined values so a Partial cannot overwrite a defined field with `undefined` —
    // legacy recent-search entries persisted with undefined numeric fields would otherwise
    // crash the URL writer downstream.
    const sanitized = Object.fromEntries(
      Object.entries(newFilters).filter(([, v]) => v !== undefined),
    ) as Partial<SearchRequestPagination>;
    const updatedFilters = {
      ...uiSearchParams,
      ...sanitized,
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
