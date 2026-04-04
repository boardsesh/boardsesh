'use client';

import React, { useState, useEffect } from 'react';
import HistoryOutlined from '@mui/icons-material/HistoryOutlined';
import { getRecentSearches, getFilterKey, RecentSearch, RECENT_SEARCHES_CHANGED_EVENT } from './recent-searches-storage';
import { useUISearchParams } from '@/app/components/queue-control/ui-searchparams-provider';
import { SearchRequestPagination } from '@/app/lib/types';
import { DEFAULT_SEARCH_PARAMS } from '@/app/lib/url-utils';
import { getSearchPillFullSummary } from './search-summary-utils';
import styles from './recent-search-pills.module.css';

const SHADOW_PILL_WIDTHS = [72, 104, 88, 96, 80];

const RecentSearchPills: React.FC = () => {
  const [searches, setSearches] = useState<RecentSearch[]>([]);
  const [hasLoadedInitialSearches, setHasLoadedInitialSearches] = useState(false);
  const { uiSearchParams, updateFilters } = useUISearchParams();

  const currentFilterKey = getFilterKey(uiSearchParams);

  useEffect(() => {
    let isMounted = true;

    const loadInitialSearches = async () => {
      const nextSearches = await getRecentSearches();
      if (!isMounted) return;
      setSearches(nextSearches);
      setHasLoadedInitialSearches(true);
    };

    const refreshSearches = () => {
      getRecentSearches().then((nextSearches) => {
        if (!isMounted) return;
        setSearches(nextSearches);
      });
    };

    void loadInitialSearches();

    const handleChange = () => refreshSearches();
    window.addEventListener(RECENT_SEARCHES_CHANGED_EVENT, handleChange);

    return () => {
      isMounted = false;
      window.removeEventListener(RECENT_SEARCHES_CHANGED_EVENT, handleChange);
    };
  }, []);

  if (!hasLoadedInitialSearches) {
    return (
      <div className={styles.container} data-testid="recent-search-pills-loading">
        <div className={styles.pillList} aria-hidden="true">
          {SHADOW_PILL_WIDTHS.map((width, index) => (
            <div
              key={`shadow-${index}`}
              className={`${styles.pill} ${styles.pillShadow}`}
              data-testid="recent-search-pill-shadow"
            >
              <HistoryOutlined className={`${styles.pillIcon} ${styles.pillShadowIcon}`} />
              <span className={styles.pillShadowLabel} style={{ width }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (searches.length === 0) return null;

  const handleApply = (filters: Partial<SearchRequestPagination>) => {
    updateFilters(filters, true);
  };

  return (
    <div className={styles.container}>
      <div className={styles.pillList}>
        {searches.map((search) => {
          const isActive = getFilterKey(search.filters) === currentFilterKey;
          // Compute full summary for tooltip (shows all filters without truncation)
          const fullFilters = { ...DEFAULT_SEARCH_PARAMS, ...search.filters } as SearchRequestPagination;
          const tooltipText = getSearchPillFullSummary(fullFilters);
          return (
            <button
              key={search.id}
              type="button"
              className={`${styles.pill} ${isActive ? styles.pillActive : ''}`}
              onClick={() => handleApply(search.filters)}
              title={tooltipText}
            >
              <HistoryOutlined className={styles.pillIcon} />
              <span className={styles.pillLabel}>{search.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default RecentSearchPills;
