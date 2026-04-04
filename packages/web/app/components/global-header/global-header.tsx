'use client';

import React, { useState } from 'react';
import Button from '@mui/material/Button';
import SearchOutlined from '@mui/icons-material/SearchOutlined';
import PlayCircleOutlineOutlined from '@mui/icons-material/PlayCircleOutlineOutlined';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import UnifiedSearchDrawer from '@/app/components/search-drawer/unified-search-drawer';
import { useSearchDrawerBridge } from '@/app/components/search-drawer/search-drawer-bridge-context';
import { DEFAULT_CLIMB_SEARCH_SUMMARY } from '@/app/components/search-drawer/search-summary-utils';
import UserDrawer from '@/app/components/user-drawer/user-drawer';
import StartSeshDrawer from '@/app/components/session-creation/start-sesh-drawer';
import SeshSettingsDrawer from '@/app/components/sesh-settings/sesh-settings-drawer';
import { usePersistentSession, useIsOnBoardRoute } from '@/app/components/persistent-session/persistent-session-context';
import { BoardConfigData } from '@/app/lib/server-board-configs';
import { isBoardListPath } from '@/app/lib/board-route-paths';
import { themeTokens } from '@/app/theme/theme-config';
import { usePathname } from 'next/navigation';
import BackButton from '@/app/components/back-button';
import Typography from '@mui/material/Typography';
import styles from './global-header.module.css';

/** Route prefix → title for pages that show a simple title header instead of the default search/sesh header */
const TITLE_HEADER_PAGES: Record<string, string> = {
  '/aurora-migration': 'Aurora Migration',
};

/** Pages where the global header is completely hidden */
const HIDDEN_HEADER_PAGES = ['/'];

interface GlobalHeaderProps {
  boardConfigs: BoardConfigData;
}

export default function GlobalHeader({ boardConfigs }: GlobalHeaderProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [startSeshOpen, setStartSeshOpen] = useState(false);
  const [seshSettingsOpen, setSeshSettingsOpen] = useState(false);
  const { activeSession } = usePersistentSession();
  const isOnBoardRoute = useIsOnBoardRoute();
  const { openClimbSearchDrawer, searchPillSummary, hasActiveFilters: filtersActive } = useSearchDrawerBridge();
  const pathname = usePathname();

  const hasActiveSession = !!activeSession;

  // On hidden-header pages, show only the avatar in a transparent bar
  if (HIDDEN_HEADER_PAGES.includes(pathname)) {
    return (
      <header className={styles.headerTransparent}>
        <UserDrawer boardConfigs={boardConfigs} />
      </header>
    );
  }

  // Check if current page wants a simple title header
  const titleHeaderPage = Object.entries(TITLE_HEADER_PAGES).find(([prefix]) => pathname.startsWith(prefix));

  // When the bridge is active (on a board list page), delegate to the board route's drawer
  const useClimbSearchBridge = openClimbSearchDrawer !== null;
  const defaultSearchPillText = isBoardListPath(pathname) ? DEFAULT_CLIMB_SEARCH_SUMMARY : 'Search';

  const handleSearchClick = () => {
    if (useClimbSearchBridge) {
      openClimbSearchDrawer();
    } else {
      setSearchOpen(true);
    }
  };

  const handleSeshClick = () => {
    if (hasActiveSession) {
      setSeshSettingsOpen(true);
    } else {
      setStartSeshOpen(true);
    }
  };

  const pillText = useClimbSearchBridge ? (searchPillSummary ?? defaultSearchPillText) : defaultSearchPillText;

  // Simple title header for specific pages (back button + title, no search/sesh)
  if (titleHeaderPage) {
    return (
      <header className={styles.header}>
        <BackButton fallbackUrl="/" />
        <Typography variant="h6" sx={{ flex: 1, margin: 0 }}>
          {titleHeaderPage[1]}
        </Typography>
      </header>
    );
  }

  return (
    <>
      <header className={styles.header}>
        <UserDrawer boardConfigs={boardConfigs} />

        <button
          id={useClimbSearchBridge ? 'onboarding-search-button' : undefined}
          className={styles.searchPillButton}
          onClick={handleSearchClick}
          type="button"
        >
          <SearchOutlined className={styles.searchPillIcon} />
          <span className={styles.searchPillText}>{pillText}</span>
          {useClimbSearchBridge && filtersActive && <span className={styles.searchPillActiveIndicator} />}
        </button>

        <Button
          variant="contained"
          size="small"
          startIcon={hasActiveSession ? <SettingsOutlined /> : <PlayCircleOutlineOutlined />}
          onClick={handleSeshClick}
          sx={hasActiveSession ? {
            backgroundColor: themeTokens.colors.success,
            '&:hover': { backgroundColor: themeTokens.colors.successHover },
          } : undefined}
        >
          Sesh
        </Button>
      </header>

      <UnifiedSearchDrawer
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        defaultCategory={isOnBoardRoute ? 'climbs' : 'boards'}
      />

      <StartSeshDrawer
        open={startSeshOpen}
        onClose={() => setStartSeshOpen(false)}
        boardConfigs={boardConfigs}
      />

      <SeshSettingsDrawer
        open={seshSettingsOpen}
        onClose={() => setSeshSettingsOpen(false)}
      />
    </>
  );
}
