'use client';
import React, { useState, useCallback } from 'react';
import IconButton from '@mui/material/IconButton';
import Box from '@mui/material/Box';
import { usePathname } from 'next/navigation';
import CircularProgress from '@mui/material/CircularProgress';
import MuiButton from '@mui/material/Button';
import SearchOutlined from '@mui/icons-material/SearchOutlined';
import UnifiedSearchDrawer from '../search-drawer/unified-search-drawer';
import AccordionSearchForm from '../search-drawer/accordion-search-form';
import { SearchDrawerBridgeInjector } from '../search-drawer/search-drawer-bridge-context';
import type { BoardDetails } from '@/app/lib/types';
import { constructCreateClimbUrl, tryConstructSlugCreateUrl } from '@/app/lib/url-utils';
import { useCurrentClimb, useSearchData } from '../graphql-queue';
import { useUISearchParams } from '../queue-control/ui-searchparams-provider';
import {
  hasActiveFilters,
  hasActiveNonNameFilters as computeNonNameFilters,
  getSearchPillSummary,
  createSearchSummaryLabels,
} from '../search-drawer/search-summary-utils';
import { addRecentSearch } from '../search-drawer/recent-searches-storage';
import AddOutlined from '@mui/icons-material/AddOutlined';
import AngleSelector from './angle-selector';
import styles from './header.module.css';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useTranslation } from 'react-i18next';

type BoardSeshHeaderProps = {
  boardDetails: BoardDetails;
  angle?: number;
  isAngleAdjustable?: boolean;
};

export default function BoardSeshHeader({ boardDetails, angle, isAngleAdjustable }: BoardSeshHeaderProps) {
  const { t } = useTranslation('climbs');
  const pathname = usePathname();
  const { currentClimb } = useCurrentClimb();
  const { totalSearchResultCount, isFetchingClimbs } = useSearchData();
  const { uiSearchParams, clearClimbSearchParams, updateFilters } = useUISearchParams();
  const [searchDropdownOpen, setSearchDropdownOpen] = useState(false);
  const isCreatePage = pathname.includes('/create');
  const isListPage = pathname.includes('/list');
  const isPlaylistPage = pathname.includes('/playlists');
  const isLogbookPage = pathname.includes('/logbook');
  const isViewPage = pathname.includes('/view/');

  // Stable callback for the bridge injector
  const openDrawer = useCallback(() => setSearchDropdownOpen(true), []);

  const summaryLabels = createSearchSummaryLabels(t);

  // Compute filter summary for the bridge
  const summary = getSearchPillSummary(uiSearchParams, summaryLabels);
  const filtersActive = hasActiveFilters(uiSearchParams);
  const nonNameFiltersActive = computeNonNameFilters(uiSearchParams);

  // Name filter callbacks for the bridge
  const handleNameFilterChange = useCallback(
    (name: string) => {
      updateFilters({ name });
    },
    [updateFilters],
  );

  // Create mode has its own header in the form — hide the board toolbar
  if (isCreatePage) {
    return null;
  }

  // Id-aware first: the name-based builder only knows the bare size slug, so on a
  // size that shares one with another on the same layout (Kilter layout 1 sizes
  // 10/27) the Create button would open the form on the other board. `boardDetails`
  // carries the numeric ids alongside the names, so the exact form is always
  // reachable here; names stay as the fallback for a board the static tables
  // don't carry.
  const createClimbUrl =
    angle !== undefined && boardDetails.layout_name && boardDetails.size_name && boardDetails.set_names
      ? (tryConstructSlugCreateUrl(
          boardDetails.board_name,
          boardDetails.layout_id,
          boardDetails.size_id,
          boardDetails.set_ids,
          angle,
        ) ??
        constructCreateClimbUrl(
          boardDetails.board_name,
          boardDetails.layout_name,
          boardDetails.size_name,
          boardDetails.size_description,
          boardDetails.set_names,
          angle,
        ))
      : null;

  // Angle selector is only needed on the climb-view drawer surface
  const hasAngleSelector = angle !== undefined && isViewPage;
  // Create button is only shown on desktop; skip on list, playlist, and logbook pages
  const hasCreateButton = !!createClimbUrl && !isListPage && !isPlaylistPage && !isLogbookPage;

  return (
    <>
      {/* Bridge injector: exposes drawer open callback and filter summary to the global header */}
      <SearchDrawerBridgeInjector
        openDrawer={openDrawer}
        summary={summary}
        hasActiveFilters={filtersActive}
        isOnListPage={isListPage}
        nameFilter={uiSearchParams.name}
        onNameFilterChange={handleNameFilterChange}
        hasActiveNonNameFilters={nonNameFiltersActive}
      />

      {(hasAngleSelector || hasCreateButton) && (
        <Box
          component="div"
          className={styles.header}
          sx={{
            background: 'var(--semantic-surface)',
            lineHeight: 'normal',
            display: 'flex',
            padding: '0 12px',
            alignItems: 'center',
            minHeight: 40,
            gap: '8px',
          }}
        >
          {/* Center Section (spacer) */}
          <Box sx={{ flex: 1 }} />

          {/* Right Section */}
          <Box sx={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
            {hasAngleSelector && (
              <AngleSelector
                boardName={boardDetails.board_name}
                boardDetails={boardDetails}
                currentAngle={angle}
                currentClimb={currentClimb}
                isAngleAdjustable={isAngleAdjustable}
              />
            )}

            {hasCreateButton && (
              <div className={styles.desktopOnly}>
                <LocaleLink href={createClimbUrl}>
                  <IconButton title={t('header.createNewClimb')}>
                    <AddOutlined />
                  </IconButton>
                </LocaleLink>
              </div>
            )}
          </Box>
        </Box>
      )}

      {/* Search drawer (controlled via bridge from global header on list pages) */}
      <UnifiedSearchDrawer
        boardDetails={boardDetails}
        defaultCategory="climbs"
        allowedCategories={['climbs']}
        showCloseButton
        showCloseButtonOnMobile
        open={searchDropdownOpen}
        onClose={() => {
          if (hasActiveFilters(uiSearchParams)) {
            const label = getSearchPillSummary(uiSearchParams, summaryLabels);
            addRecentSearch(label, uiSearchParams).catch(() => {});
          }
          setSearchDropdownOpen(false);
        }}
        renderClimbSearch={() => <AccordionSearchForm boardDetails={boardDetails} />}
        renderClimbFooter={() => {
          const currentFiltersActive = hasActiveFilters(uiSearchParams);
          const resultCount = totalSearchResultCount ?? 0;
          const showResultCount = currentFiltersActive && !isFetchingClimbs && resultCount > 0;
          return (
            <Box
              sx={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                py: 2,
                px: 3,
                background: 'var(--semantic-surface)',
                borderTop: '1px solid var(--neutral-100)',
              }}
            >
              <MuiButton
                variant="text"
                onClick={clearClimbSearchParams}
                sx={{
                  textDecoration: 'underline',
                  fontWeight: 600,
                  color: 'var(--neutral-900)',
                  p: 0,
                  minWidth: 'auto',
                }}
              >
                {t('search.actions.clearAll')}
              </MuiButton>
              <MuiButton
                variant="contained"
                startIcon={isFetchingClimbs ? <CircularProgress size={20} /> : <SearchOutlined />}
                onClick={() => {
                  if (currentFiltersActive) {
                    const label = getSearchPillSummary(uiSearchParams, summaryLabels);
                    addRecentSearch(label, uiSearchParams).catch(() => {});
                  }
                  setSearchDropdownOpen(false);
                }}
                size="large"
                sx={{ borderRadius: 3, height: 48, px: 3, fontSize: 16, fontWeight: 600 }}
              >
                {t('search.actions.search')}
                {showResultCount ? ` \u00B7 ${resultCount.toLocaleString()}` : ''}
              </MuiButton>
            </Box>
          );
        }}
      />
    </>
  );
}
