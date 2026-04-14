'use client';

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import ClimbListItem from '../climb-card/climb-list-item';
import { useColorMode } from '@/app/hooks/use-color-mode';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  SEARCH_DRAFT_CLIMBS,
  type ClimbSearchInputVariables,
  type ClimbSearchResponse,
} from '@/app/lib/graphql/operations/climb-search';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { themeTokens } from '@/app/theme/theme-config';
import { constructClimbViewUrl } from '@/app/lib/url-utils';
import type { BoardDetails, Climb } from '@/app/lib/types';
import queueStyles from '../play-view/play-view-drawer.module.css';
import drawerStyles from '../swipeable-drawer/swipeable-drawer.module.css';

const DRAFTS_DRAWER_STYLES = {
  wrapper: {
    touchAction: 'pan-y' as const,
    transition: themeTokens.transitions.drawerHeight,
  },
  body: { padding: 0, overflow: 'hidden' as const, touchAction: 'pan-y' as const },
} as const;

export interface DraftsDrawerProps {
  open: boolean;
  onClose: () => void;
  boardDetails: BoardDetails;
  angle: number;
  /**
   * Called when the user taps a draft. When provided, the drawer delegates to
   * the host (typically the create form) so the draft's holds, name, and
   * description are loaded back into the editor. When omitted, the drawer
   * falls back to navigating to the climb view page.
   */
  onLoadDraft?: (climb: Climb) => void;
}

const DraftsDrawer: React.FC<DraftsDrawerProps> = ({ open, onClose, boardDetails, angle, onLoadDraft }) => {
  const router = useRouter();
  const { mode } = useColorMode();
  const isDark = mode === 'dark';
  const { token: wsAuthToken } = useWsAuthToken();

  const draftsDrawerHeightRef = useRef('60%');
  const draftsPaperRef = useRef<HTMLDivElement>(null);

  const updateDraftsDrawerHeight = useCallback((height: string) => {
    draftsDrawerHeightRef.current = height;
    if (draftsPaperRef.current) {
      draftsPaperRef.current.style.height = height;
    }
  }, []);

  useEffect(() => {
    if (!open) {
      updateDraftsDrawerHeight('60%');
    }
  }, [open, updateDraftsDrawerHeight]);

  // Drag-to-resize handlers on the header
  const dragStartY = useRef<number>(0);
  const dragStartHeightRef = useRef<string>('60%');
  const isDragGestureRef = useRef(false);

  const handleDragStart = useCallback((e: React.TouchEvent) => {
    dragStartY.current = e.touches[0].clientY;
    dragStartHeightRef.current = draftsDrawerHeightRef.current;
    isDragGestureRef.current = false;
  }, []);

  const handleDragMove = useCallback((e: React.TouchEvent) => {
    const delta = Math.abs(e.touches[0].clientY - dragStartY.current);
    if (delta > 10) {
      isDragGestureRef.current = true;
    }
  }, []);

  const handleDragEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!isDragGestureRef.current) return;
      const deltaY = e.changedTouches[0].clientY - dragStartY.current;
      const THRESHOLD = 30;

      if (deltaY < -THRESHOLD) {
        updateDraftsDrawerHeight('100%');
      } else if (deltaY > THRESHOLD) {
        if (dragStartHeightRef.current === '100%') {
          updateDraftsDrawerHeight('60%');
        } else {
          onClose();
        }
      }
    },
    [onClose, updateDraftsDrawerHeight],
  );

  // Query: only run when drawer is open and user has a token
  const queryKey = useMemo(
    () =>
      [
        'climbDrafts',
        boardDetails.board_name,
        boardDetails.layout_id,
        boardDetails.size_id,
        boardDetails.set_ids.join(','),
        angle,
      ] as const,
    [boardDetails.board_name, boardDetails.layout_id, boardDetails.size_id, boardDetails.set_ids, angle],
  );

  const { data, isLoading, error } = useQuery({
    queryKey,
    enabled: open && !!wsAuthToken,
    queryFn: async (): Promise<Climb[]> => {
      const input: ClimbSearchInputVariables['input'] = {
        boardName: boardDetails.board_name,
        layoutId: boardDetails.layout_id,
        sizeId: boardDetails.size_id,
        setIds: boardDetails.set_ids.join(','),
        angle,
        page: 0,
        pageSize: 100,
        sortBy: 'ascents',
        sortOrder: 'desc',
        onlyDrafts: true,
      };
      const client = createGraphQLHttpClient(wsAuthToken);
      const result = await client.request<ClimbSearchResponse>(SEARCH_DRAFT_CLIMBS, { input });
      return result.searchClimbs.climbs;
    },
    refetchOnWindowFocus: false,
  });

  const drafts = data ?? [];

  const handleSelectDraft = useCallback(
    (climb: Climb) => {
      if (onLoadDraft) {
        onLoadDraft(climb);
        onClose();
        return;
      }

      const url = constructClimbViewUrl(
        {
          board_name: boardDetails.board_name,
          layout_id: boardDetails.layout_id,
          size_id: boardDetails.size_id,
          set_ids: boardDetails.set_ids,
          angle,
        },
        climb.uuid,
        climb.name,
      );
      onClose();
      router.push(url);
    },
    [router, onClose, boardDetails, angle, onLoadDraft],
  );

  // Current page pathname for ClimbListItem (used for thumbnail prefetch hints)
  const pathname = useMemo(
    () =>
      `/${boardDetails.board_name}/${boardDetails.layout_id}/${boardDetails.size_id}/${boardDetails.set_ids.join(',')}/${angle}/create`,
    [boardDetails, angle],
  );

  return (
    <SwipeableDrawer
      placement="bottom"
      height="60%"
      paperRef={draftsPaperRef}
      open={open}
      showCloseButton={false}
      swipeEnabled={false}
      showDragHandle={false}
      onClose={onClose}
      styles={DRAFTS_DRAWER_STYLES}
    >
      {/* Drag header */}
      <div
        className={queueStyles.queueDragHeader}
        data-swipe-blocked=""
        onTouchStart={handleDragStart}
        onTouchMove={handleDragMove}
        onTouchEnd={handleDragEnd}
      >
        <div className={drawerStyles.dragHandleZoneHorizontal}>
          <div className={drawerStyles.dragHandleBarHorizontal} />
        </div>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: `${themeTokens.spacing[4]}px ${themeTokens.spacing[6]}px`,
            borderBottom: '1px solid var(--neutral-200)',
          }}
        >
          <Typography
            variant="h6"
            component="div"
            sx={{
              fontWeight: themeTokens.typography.fontWeight.semibold,
              fontSize: themeTokens.typography.fontSize.base,
            }}
          >
            Drafts
          </Typography>
          {drafts.length > 0 && (
            <Typography variant="body2" color="text.secondary">
              {drafts.length} draft{drafts.length === 1 ? '' : 's'}
            </Typography>
          )}
        </Box>
      </div>

      <div className={queueStyles.queueBodyLayout}>
        <div className={queueStyles.queueScrollContainer}>
          {isLoading ? (
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: themeTokens.spacing[8],
              }}
            >
              <CircularProgress size={24} />
            </Box>
          ) : error ? (
            <Box sx={{ padding: themeTokens.spacing[6], textAlign: 'center' }}>
              <Typography variant="body2" color="text.secondary">
                Couldn&apos;t load your drafts. Try again.
              </Typography>
            </Box>
          ) : drafts.length === 0 ? (
            <Box sx={{ padding: themeTokens.spacing[8], textAlign: 'center' }}>
              <Typography variant="body1" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold }}>
                No drafts yet
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ marginTop: 1 }}>
                Save a climb as a draft to pick it up later.
              </Typography>
            </Box>
          ) : (
            drafts.map((climb) => (
              <ClimbListItem
                key={climb.uuid}
                climb={climb}
                boardDetails={boardDetails}
                pathname={pathname}
                isDark={isDark}
                disableSwipe
                onSelect={() => handleSelectDraft(climb)}
              />
            ))
          )}
        </div>
      </div>
    </SwipeableDrawer>
  );
};

export default React.memo(DraftsDrawer);
