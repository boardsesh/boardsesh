'use client';

import React, { useCallback, useState } from 'react';
import Box from '@mui/material/Box';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import ActivityFeed from '@/app/components/activity-feed/activity-feed';
import ProposalFeed from '@/app/components/activity-feed/proposal-feed';
import CommentFeed from '@/app/components/activity-feed/comment-feed';
import { useSession } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';

import BoardScrollSection from '@/app/components/board-scroll/board-scroll-section';
import BoardScrollCard from '@/app/components/board-scroll/board-scroll-card';
import type { SessionFeedResult } from '@boardsesh/shared-schema';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useMyBoards } from '@/app/hooks/use-my-boards';
import boardScrollStyles from '@/app/components/board-scroll/board-scroll.module.css';
import UnifiedSearchDrawer from '@/app/components/search-drawer/unified-search-drawer';

type FeedTab = 'sessions' | 'proposals' | 'comments';
const VALID_TABS: FeedTab[] = ['sessions', 'proposals', 'comments'];

interface FeedPageContentProps {
  initialTab?: FeedTab;
  initialBoardUuid?: string;
  initialFeedResult?: SessionFeedResult | null;
  isAuthenticatedSSR?: boolean;
  initialMyBoards?: UserBoard[] | null;
}

export default function FeedPageContent({
  initialTab = 'sessions',
  initialBoardUuid,
  initialFeedResult,
  isAuthenticatedSSR,
  initialMyBoards,
}: FeedPageContentProps) {
  const { status } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();

  // Trust the SSR hint during the loading phase to prevent flash of unauthenticated content
  const isAuthenticated = status === 'authenticated' ? true : (status === 'loading' ? (isAuthenticatedSSR ?? false) : false);
  const { boards: myBoards, isLoading: isLoadingBoards } = useMyBoards(isAuthenticated, 50, initialMyBoards);

  // Read state from URL params (with fallbacks to server-provided initial values)
  const tabParam = searchParams.get('tab');
  const activeTab: FeedTab = VALID_TABS.includes(tabParam as FeedTab)
    ? (tabParam as FeedTab)
    : initialTab;
  const selectedBoardUuid = searchParams.get('board') || initialBoardUuid || null;
  const [findClimbersOpen, setFindClimbersOpen] = useState(false);

  // Helper: update a URL param via shallow navigation
  const updateParam = useCallback((key: string, value: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    // Default tab is 'sessions', don't put in URL
    if (key === 'tab' && value === 'sessions') {
      params.delete(key);
    } else if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    const qs = params.toString();
    router.push(qs ? `/feed?${qs}` : '/feed', { scroll: false });
  }, [router, searchParams]);

  const handleTabChange = (_: React.SyntheticEvent, value: FeedTab) => {
    updateParam('tab', value);
  };

  const handleBoardFilter = useCallback((boardUuid: string | null) => {
    updateParam('board', boardUuid);
  }, [updateParam]);

  const handleBoardSelect = useCallback((board: UserBoard) => {
    updateParam('board', board.uuid);
  }, [updateParam]);

  return (
    <Box sx={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', pb: 'calc(120px + env(safe-area-inset-bottom, 0px))' }}>
      {/* Feed */}
      <Box component="main" sx={{ flex: 1, px: 2, py: 2, pt: 'calc(var(--global-header-height) + 16px)' }}>
        {isAuthenticated && (myBoards.length > 0 || isLoadingBoards) && (
          <BoardScrollSection loading={isLoadingBoards} size="small">
            <div
              className={`${boardScrollStyles.cardScroll} ${boardScrollStyles.cardScrollSmall}`}
              onClick={() => {
                handleBoardFilter(null);
              }}
            >
              <div className={`${boardScrollStyles.cardSquare} ${boardScrollStyles.filterSquare} ${!selectedBoardUuid ? boardScrollStyles.cardSquareSelected : ''}`}>
                <span className={boardScrollStyles.filterLabel}>All</span>
              </div>
              <div className={`${boardScrollStyles.cardName} ${!selectedBoardUuid ? boardScrollStyles.cardNameSelected : ''}`}>
                All Boards
              </div>
            </div>
            {myBoards.map((board) => (
              <BoardScrollCard
                key={board.uuid}
                userBoard={board}
                size="small"
                selected={selectedBoardUuid === board.uuid}
                onClick={() => handleBoardSelect(board)}
              />
            ))}
          </BoardScrollSection>
        )}
        <Tabs
          value={activeTab}
          onChange={handleTabChange}
          variant="fullWidth"
          sx={{ mb: 2 }}
          aria-label="Feed tabs"
        >
          <Tab label="Sessions" value="sessions" />
          <Tab label="Proposals" value="proposals" />
          <Tab label="Comments" value="comments" />
        </Tabs>

        {activeTab === 'sessions' && (
          <ActivityFeed
            isAuthenticated={isAuthenticated}
            boardUuid={selectedBoardUuid}
            initialFeedResult={initialFeedResult}
            onFindClimbers={() => setFindClimbersOpen(true)}
          />
        )}

        {activeTab === 'proposals' && (
          <ProposalFeed
            isAuthenticated={isAuthenticated}
            boardUuid={selectedBoardUuid}
          />
        )}

        {activeTab === 'comments' && (
          <CommentFeed
            isAuthenticated={isAuthenticated}
            boardUuid={selectedBoardUuid}
          />
        )}
      </Box>

      <UnifiedSearchDrawer
        open={findClimbersOpen}
        onClose={() => setFindClimbersOpen(false)}
        defaultCategory="users"
      />
    </Box>
  );
}
