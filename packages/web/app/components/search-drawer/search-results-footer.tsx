'use client';

import React from 'react';
import CircularProgress from '@mui/material/CircularProgress';
import MuiTypography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import FilterListOutlined from '@mui/icons-material/FilterListOutlined';
import { useSearchData } from '@/app/components/graphql-queue';
import ClearButton from './clear-button';
import { useUISearchParams } from '../queue-control/ui-searchparams-provider';
import { DEFAULT_SEARCH_PARAMS } from '@/app/lib/url-utils';
import { themeTokens } from '@/app/theme/theme-config';
import styles from './search-form.module.css';


const SearchResultsFooter = () => {
  const { totalSearchResultCount, isFetchingClimbs } = useSearchData();
  const { uiSearchParams } = useUISearchParams();

  // Check if any filters are active
  const hasActiveFilters = Object.entries(uiSearchParams).some(([key, value]) => {
    if (key === 'holdsFilter') {
      // Check if holdsFilter has any entries
      return Object.keys(value || {}).length > 0;
    }
    return value !== DEFAULT_SEARCH_PARAMS[key as keyof typeof DEFAULT_SEARCH_PARAMS];
  });

  // Only show footer when filters are active
  if (!hasActiveFilters) {
    return null;
  }

  return (
    <div className={styles.searchFooter}>
      <div className={styles.resultCount}>
        {isFetchingClimbs ? (
          <CircularProgress size={20} />
        ) : (
          <Stack direction="row" spacing={1}>
            <FilterListOutlined style={{ color: themeTokens.colors.primary }} />
            <MuiTypography variant="body2" component="span" color="text.secondary">
              <span className={styles.resultBadge}>{(totalSearchResultCount ?? 0).toLocaleString()}</span> results
            </MuiTypography>
          </Stack>
        )}
      </div>
      <ClearButton />
    </div>
  );
};

export default SearchResultsFooter;