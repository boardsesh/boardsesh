'use client';
import React, { useState, useCallback } from 'react';
import IconButton from '@mui/material/IconButton';
import Box from '@mui/material/Box';
import { usePathname, useSearchParams, useRouter } from 'next/navigation';
import CircularProgress from '@mui/material/CircularProgress';
import MuiButton from '@mui/material/Button';
import SearchOutlined from '@mui/icons-material/SearchOutlined';
import UnifiedSearchDrawer from '../search-drawer/unified-search-drawer';
import AccordionSearchForm from '../search-drawer/accordion-search-form';
import { SearchDrawerBridgeInjector } from '../search-drawer/search-drawer-bridge-context';
import { BoardDetails } from '@/app/lib/types';
import { constructClimbListWithSlugs, generateLayoutSlug, generateSizeSlug, generateSetSlug } from '@/app/lib/url-utils';
import { useCurrentClimb, useSearchData } from '../graphql-queue';
import { useUISearchParams } from '../queue-control/ui-searchparams-provider';
import { hasActiveFilters, getSearchPillSummary } from '../search-drawer/search-summary-utils';
import { addRecentSearch } from '../search-drawer/recent-searches-storage';
import AddOutlined from '@mui/icons-material/AddOutlined';
import ChevronLeftOutlined from '@mui/icons-material/ChevronLeftOutlined';
import AngleSelector from './angle-selector';
import styles from './header.module.css';
import Link from 'next/link';

type PageMode = 'list' | 'view' | 'play' | 'create' | 'other';

type BoardSeshHeaderProps = {
  boardDetails: BoardDetails;
  angle?: number;
  isAngleAdjustable?: boolean;
};

function usePageMode(): PageMode {
  const pathname = usePathname();

  return React.useMemo(() => {
    if (pathname.includes('/play/')) return 'play';
    if (pathname.includes('/view/')) return 'view';
    if (pathname.includes('/list')) return 'list';
    if (pathname.includes('/create')) return 'create';
    return 'other';
  }, [pathname]);
}

export default function BoardSeshHeader({ boardDetails, angle, isAngleAdjustable }: BoardSeshHeaderProps) {
  const { currentClimb } = useCurrentClimb();
  const { totalSearchResultCount, isFetchingClimbs } = useSearchData();
  const { uiSearchParams, clearClimbSearchParams } = useUISearchParams();
  const pageMode = usePageMode();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [searchDropdownOpen, setSearchDropdownOpen] = useState(false);

  // Stable callback for the bridge injector
  const openDrawer = useCallback(() => setSearchDropdownOpen(true), []);

  // Compute filter summary for the bridge
  const summary = getSearchPillSummary(uiSearchParams);
  const filtersActive = hasActiveFilters(uiSearchParams);

  // Create mode has its own header in the form — hide the board toolbar
  if (pageMode === 'create') {
    return null;
  }

  // Build back to list URL for play/view pages
  const getBackToListUrl = () => {
    const { board_name, layout_name, size_name, size_description, set_names } = boardDetails;

    let baseUrl: string;
    if (layout_name && size_name && set_names && angle !== undefined) {
      baseUrl = constructClimbListWithSlugs(board_name, layout_name, size_name, size_description, set_names, angle);
    } else {
      baseUrl = `/${board_name}/${boardDetails.layout_id}/${boardDetails.size_id}/${boardDetails.set_ids.join(',')}/${angle}/list`;
    }

    // Preserve search params when going back
    const queryString = searchParams.toString();
    if (queryString) {
      return `${baseUrl}?${queryString}`;
    }
    return baseUrl;
  };

  const createClimbUrl = angle !== undefined && boardDetails.layout_name && boardDetails.size_name && boardDetails.set_names
    ? `/${boardDetails.board_name}/${generateLayoutSlug(boardDetails.layout_name)}/${generateSizeSlug(boardDetails.size_name, boardDetails.size_description)}/${generateSetSlug(boardDetails.set_names)}/${angle}/create`
    : null;

  // Check if we have any content to show — if not, don't render the toolbar
  const hasBackButton = pageMode === 'play';
  // Angle selector is now rendered inside ClimbsList on list pages
  const hasAngleSelector = angle !== undefined && pageMode !== 'list';
  // Create button is only shown on desktop, so skip rendering the container on list pages
  const hasCreateButton = !!createClimbUrl && pageMode !== 'list';

  return (
    <>
      {/* Bridge injector: exposes drawer open callback and filter summary to the global header */}
      <SearchDrawerBridgeInjector
        openDrawer={openDrawer}
        summary={summary}
        hasActiveFilters={filtersActive}
        isOnListPage={pageMode === 'list'}
      />

      {(hasBackButton || hasAngleSelector || hasCreateButton) && (
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
          {/* Left section: Back button */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
            {hasBackButton && (
              <div className={styles.mobileOnly}>
                <IconButton
                  aria-label="Back to climb list"
                  onClick={() => router.push(getBackToListUrl())}
                >
                  <ChevronLeftOutlined />
                </IconButton>
              </div>
            )}
          </Box>

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
                <Link href={createClimbUrl}>
                  <IconButton title="Create new climb">
                    <AddOutlined />
                  </IconButton>
                </Link>
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
            const label = getSearchPillSummary(uiSearchParams);
            addRecentSearch(label, uiSearchParams).catch(() => {});
          }
          setSearchDropdownOpen(false);
        }}
        renderClimbSearch={() => (
          <AccordionSearchForm boardDetails={boardDetails} />
        )}
        renderClimbFooter={() => {
          const currentFiltersActive = hasActiveFilters(uiSearchParams);
          const resultCount = totalSearchResultCount ?? 0;
          const showResultCount = currentFiltersActive && !isFetchingClimbs && resultCount > 0;
          return (
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', py: 2, px: 3, background: 'var(--semantic-surface)', borderTop: '1px solid var(--neutral-100)' }}>
              <MuiButton
                variant="text"
                onClick={clearClimbSearchParams}
                sx={{ textDecoration: 'underline', fontWeight: 600, color: 'var(--neutral-900)', p: 0, minWidth: 'auto' }}
              >
                Clear all
              </MuiButton>
              <MuiButton
                variant="contained"
                startIcon={isFetchingClimbs ? <CircularProgress size={20} /> : <SearchOutlined />}
                onClick={() => {
                  if (currentFiltersActive) {
                    const label = getSearchPillSummary(uiSearchParams);
                    addRecentSearch(label, uiSearchParams).catch(() => {});
                  }
                  setSearchDropdownOpen(false);
                }}
                size="large"
                sx={{ borderRadius: 3, height: 48, px: 3, fontSize: 16, fontWeight: 600 }}
              >
                Search{showResultCount ? ` \u00B7 ${resultCount.toLocaleString()}` : ''}
              </MuiButton>
            </Box>
          );
        }}
      />
    </>
  );
}
