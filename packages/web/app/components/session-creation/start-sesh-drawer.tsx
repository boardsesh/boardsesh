'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { track } from '@/app/lib/analytics';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import LoginOutlined from '@mui/icons-material/LoginOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import PlayCircleOutlineOutlined from '@mui/icons-material/PlayCircleOutlineOutlined';
import CircularProgress from '@mui/material/CircularProgress';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import drawerCss from '../swipeable-drawer/swipeable-drawer.module.css';
import { useDrawerDragResize } from '@/app/hooks/use-drawer-drag-resize';
import { themeTokens } from '@/app/theme/theme-config';
import SessionCreationForm, { type SessionCreationFormData } from './session-creation-form';
import BoardSelectorDrawer from '@/app/components/board-selector-drawer/board-selector-drawer';
import BoardDiscoveryScroll from '@/app/components/board-scroll/board-discovery-scroll';
import BoardScrollCard from '@/app/components/board-scroll/board-scroll-card';
import { useCreateSession } from '@/app/hooks/use-create-session';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { useSession } from 'next-auth/react';
import { useRouter, usePathname } from 'next/navigation';
import {
  constructBoardSlugListUrl,
  getBaseBoardPath,
  constructClimbListWithSlugs,
  tryConstructSlugListUrl,
} from '@/app/lib/url-utils';
import { getDefaultAngleForBoard } from '@/app/lib/board-config-for-playlist';
import { isBoardRoutePath } from '@/app/lib/board-route-paths';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import { setClimbSessionCookie } from '@/app/lib/climb-session-cookie';
import { usePersistentSession } from '@/app/components/persistent-session/persistent-session-context';
import { useQueueBridgeBoardInfo } from '@/app/components/queue-control/queue-bridge-context';
import { useQueueList, useCurrentClimb } from '@/app/components/graphql-queue';
import { useMyBoards } from '@/app/hooks/use-my-boards';
import type { BoardConfigData } from '@/app/lib/server-board-configs';
import type { StoredBoardConfig } from '@/app/lib/saved-boards-db';
import type { UserBoard, PopularBoardConfig } from '@boardsesh/shared-schema';
import type { BoardName } from '@/app/lib/types';

type StartSeshDrawerProps = {
  open: boolean;
  onClose: () => void;
  onTransitionEnd?: (open: boolean) => void;
  boardConfigs?: BoardConfigData;
};

export default function StartSeshDrawer({ open, onClose, onTransitionEnd, boardConfigs }: StartSeshDrawerProps) {
  const { status } = useSession();
  const { paperRef, dragHandlers } = useDrawerDragResize({ open, onClose });
  const router = useRouter();
  const { showMessage } = useSnackbar();
  const { createSession, isCreating } = useCreateSession();
  const {
    activateSession,
    setInitialQueueForSession,
    localQueue,
    localCurrentClimbQueueItem,
    localBoardPath,
    localBoardDetails,
  } = usePersistentSession();
  const pathname = usePathname();
  const { boardDetails: bridgeBoardDetails, angle: bridgeAngle } = useQueueBridgeBoardInfo();
  const { queue: bridgeQueue } = useQueueList();
  const { currentClimbQueueItem: bridgeCurrentClimbQueueItem } = useCurrentClimb();
  const { boards, error: boardsError } = useMyBoards(open);

  const [selectedBoard, setSelectedBoard] = useState<(typeof boards)[number] | null>(null);
  const [selectedCustomPath, setSelectedCustomPath] = useState<string | null>(null);
  const [selectedCustomConfig, setSelectedCustomConfig] = useState<StoredBoardConfig | null>(null);
  const { openAuthModal } = useAuthModal();
  const [showBoardDrawer, setShowBoardDrawer] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [boardSelectorExpanded, setBoardSelectorExpanded] = useState(false);
  const hasAutoSelectedRef = useRef(false);
  const formSubmitRef = useRef<(() => void) | null>(null);

  // Reset auto-selection tracking when drawer closes
  useEffect(() => {
    if (!open) {
      hasAutoSelectedRef.current = false;
    }
  }, [open]);

  // Auto-select the current board when the drawer opens
  useEffect(() => {
    if (!open || boards.length === 0 || hasAutoSelectedRef.current) return;

    let match: (typeof boards)[number] | undefined;

    // Strategy 1: Match by slug from /b/{slug} routes
    if (localBoardPath) {
      const basePath = getBaseBoardPath(localBoardPath);
      match = boards.find((b) => `/b/${b.slug}` === basePath);
    }

    // Strategy 2: Match by numeric board identity from localBoardDetails
    if (!match && localBoardDetails) {
      const sortedLocalSetIds = [...localBoardDetails.set_ids].sort((a, b) => a - b).join(',');
      match = boards.find(
        (b) =>
          b.boardType === localBoardDetails.board_name &&
          b.layoutId === localBoardDetails.layout_id &&
          b.sizeId === localBoardDetails.size_id &&
          b.setIds
            .split(',')
            .map(Number)
            .sort((a, b) => a - b)
            .join(',') === sortedLocalSetIds,
      );
    }

    // Strategy 3: Match by slug from current pathname
    if (!match && pathname?.startsWith('/b/')) {
      const segments = pathname.split('/').filter(Boolean);
      if (segments.length >= 2) {
        const slug = segments[1];
        match = boards.find((b) => b.slug === slug);
      }
    }

    hasAutoSelectedRef.current = true;
    if (match) {
      setSelectedBoard(match);
    }
  }, [open, boards, localBoardPath, localBoardDetails, pathname]);

  const isLoggedIn = status === 'authenticated';

  const handleClose = useCallback(() => {
    onClose();
    setSelectedBoard(null);
    setSelectedCustomPath(null);
    setSelectedCustomConfig(null);
    setBoardSelectorExpanded(false);
    setFormKey((k) => k + 1);
  }, [onClose]);

  const handleBoardSelect = useCallback((board: UserBoard) => {
    setSelectedBoard(board);
    setSelectedCustomPath(null);
    setSelectedCustomConfig(null);
    setBoardSelectorExpanded(false);
  }, []);

  const handleDiscoveryBoardClick = useCallback(
    (board: UserBoard) => {
      handleBoardSelect(board);
    },
    [handleBoardSelect],
  );

  const handleConfigClick = useCallback((config: PopularBoardConfig) => {
    // For popular configs in the session drawer, navigate to that board config
    const angle = getDefaultAngleForBoard(config.boardType);
    let url: string;
    if (config.layoutName && config.sizeName && config.setNames.length > 0) {
      url = constructClimbListWithSlugs(
        config.boardType,
        config.layoutName,
        config.sizeName,
        config.sizeDescription ?? undefined,
        config.setNames,
        angle,
      );
    } else {
      const setIds = config.setIds.join(',');
      url =
        tryConstructSlugListUrl(config.boardType, config.layoutId, config.sizeId, config.setIds, angle) ??
        `/${config.boardType}/${config.layoutId}/${config.sizeId}/${setIds}/${angle}/list`;
    }
    // Store as custom path selection
    setSelectedCustomPath(url);
    setSelectedCustomConfig({
      name: config.displayName,
      board: config.boardType as BoardName,
      layoutId: config.layoutId,
      sizeId: config.sizeId,
      setIds: config.setIds,
      angle,
      createdAt: new Date().toISOString(),
    });
    setSelectedBoard(null);
    setBoardSelectorExpanded(false);
  }, []);

  const handleCustomSelect = (url: string, config?: StoredBoardConfig) => {
    setSelectedCustomPath(url);
    setSelectedCustomConfig(config ?? null);
    setSelectedBoard(null);
    setShowBoardDrawer(false);
    setBoardSelectorExpanded(false);
  };

  const handleSubmit = async (formData: SessionCreationFormData) => {
    let boardPath: string | undefined;
    let navigateUrl: string | undefined;

    if (selectedBoard) {
      boardPath = `/b/${selectedBoard.slug}`;
      navigateUrl = constructBoardSlugListUrl(selectedBoard.slug, selectedBoard.angle);
    } else if (selectedCustomPath) {
      boardPath = selectedCustomPath;
      navigateUrl = selectedCustomPath;
    } else if (isBoardRoutePath(pathname)) {
      boardPath = getBaseBoardPath(pathname);
      navigateUrl = pathname;
    }

    if (!boardPath || !navigateUrl) {
      showMessage('Please select a board first', 'warning');
      return;
    }

    try {
      const sessionId = await createSession(formData, boardPath);

      // Effective values: prefer local state, fall back to bridge context.
      // Local state may be empty when the QueueBridgeInjector is active on a
      // board route — it only syncs to local state on cleanup (navigating away).
      const effectiveBoardDetails = localBoardDetails ?? bridgeBoardDetails;
      const effectiveBaseBoardPath = localBoardPath
        ? getBaseBoardPath(localBoardPath)
        : bridgeBoardDetails && pathname
          ? getBaseBoardPath(pathname)
          : null;
      const effectiveQueue = localQueue.length > 0 ? localQueue : bridgeQueue;
      const effectiveCurrentClimb = localCurrentClimbQueueItem ?? bridgeCurrentClimbQueueItem;
      const boardsMatch = effectiveBaseBoardPath != null && effectiveBaseBoardPath === getBaseBoardPath(boardPath);

      // Transfer existing queue to the new session if on the same board
      if (boardsMatch && (effectiveQueue.length > 0 || effectiveCurrentClimb)) {
        setInitialQueueForSession(sessionId, effectiveQueue, effectiveCurrentClimb, formData.name);
      }

      setClimbSessionCookie(sessionId);

      // Activate the session immediately so the UI updates without needing a reload.
      // We pass boardPath (the form-derived base path, e.g. /b/slug) rather than
      // the full route pathname — this is the canonical path for the session and
      // matches what BoardSessionBridge compares against.
      if (effectiveBoardDetails && boardsMatch) {
        const angle = selectedBoard?.angle ?? selectedCustomConfig?.angle ?? bridgeAngle ?? 0;
        activateSession({
          sessionId,
          sessionName: formData.name,
          boardPath,
          boardDetails: effectiveBoardDetails,
          parsedParams: {
            board_name: effectiveBoardDetails.board_name,
            layout_id: effectiveBoardDetails.layout_id,
            size_id: effectiveBoardDetails.size_id,
            set_ids: effectiveBoardDetails.set_ids,
            angle,
          },
          namedBoardName: selectedBoard?.name,
          namedBoardUuid: selectedBoard?.uuid,
        });
      }

      router.push(navigateUrl);

      track('Session Started', {
        boardName: effectiveBoardDetails?.board_name ?? '',
        hasGoal: !!formData.goal,
        isDiscoverable: !!formData.discoverable,
      });

      handleClose();
      showMessage('Session started!', 'success');
    } catch (error) {
      console.error('Failed to create session:', error);
      showMessage('Failed to start session', 'error');
      throw error;
    }
  };

  const hasSelection = selectedBoard || selectedCustomConfig;

  const boardSelector = (
    <Box>
      {hasSelection && !boardSelectorExpanded ? (
        <Box>
          <Typography sx={{ fontSize: 16, fontWeight: 600, color: 'var(--neutral-900)', mb: 1.5 }}>
            Boards near you
          </Typography>
          <Box
            data-testid="selected-board-card"
            sx={{ position: 'relative', width: 'fit-content' }}
            onClick={() => setBoardSelectorExpanded(true)}
          >
            <BoardScrollCard
              userBoard={selectedBoard ?? undefined}
              storedConfig={selectedCustomConfig ?? undefined}
              boardConfigs={boardConfigs}
              selected
              onClick={() => setBoardSelectorExpanded(true)}
            />
            {/* Grey overlay + edit icon */}
            <Box
              sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                aspectRatio: 1,
                borderRadius: '8px',
                bgcolor: 'rgba(0, 0, 0, 0.3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                pointerEvents: 'none',
              }}
            >
              <EditOutlined sx={{ color: '#fff', fontSize: 28 }} />
            </Box>
          </Box>
        </Box>
      ) : (
        <BoardDiscoveryScroll
          onBoardClick={handleDiscoveryBoardClick}
          onConfigClick={handleConfigClick}
          onCustomClick={() => setShowBoardDrawer(true)}
          selectedBoardUuid={selectedBoard?.uuid}
          myBoards={boards}
        />
      )}
      {boardsError && (
        <Typography variant="body2" color="error" sx={{ mt: 0.5 }}>
          {boardsError}
        </Typography>
      )}
    </Box>
  );

  return (
    <>
      <SwipeableDrawer
        title={
          <div data-swipe-blocked="" {...dragHandlers} className={drawerCss.dragHeaderWrapper}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Start session
            </Typography>
          </div>
        }
        placement="bottom"
        height="60%"
        paperRef={paperRef}
        swipeEnabled={false}
        open={open}
        onClose={handleClose}
        onTransitionEnd={onTransitionEnd}
        styles={{
          wrapper: {
            width: '100%',
            touchAction: 'pan-y' as const,
            transition: 'height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          },
          header: {
            paddingLeft: `${themeTokens.spacing[3]}px`,
            paddingRight: `${themeTokens.spacing[3]}px`,
          },
          body: { padding: `${themeTokens.spacing[2]}px 0` },
        }}
        footer={
          <Button
            variant="contained"
            size="large"
            startIcon={isCreating ? <CircularProgress size={16} /> : <PlayCircleOutlineOutlined />}
            onClick={() => formSubmitRef.current?.()}
            disabled={isCreating}
            fullWidth
          >
            Sesh
          </Button>
        }
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Typography variant="body2" component="span">
            {isLoggedIn
              ? 'Track your climbs and invite others to join.'
              : 'Jump in without an account. Sign in later to save your progress.'}
          </Typography>
          <SessionCreationForm
            key={formKey}
            onSubmit={handleSubmit}
            isSubmitting={isCreating}
            submitLabel="Sesh"
            headerContent={boardSelector}
            isAnonymous={!isLoggedIn}
            renderSubmit={({ onSubmit: formSubmit }) => {
              formSubmitRef.current = formSubmit;
              return null;
            }}
          />
          {!isLoggedIn && (
            <Button
              variant="text"
              size="small"
              startIcon={<LoginOutlined />}
              onClick={() =>
                openAuthModal({
                  title: 'Sign in to save your session',
                  description: "Your sends won't disappear when you close the tab.",
                })
              }
              sx={{ alignSelf: 'center' }}
            >
              Sign in for more features
            </Button>
          )}
        </Box>
      </SwipeableDrawer>

      {boardConfigs && (
        <BoardSelectorDrawer
          open={showBoardDrawer}
          onClose={() => setShowBoardDrawer(false)}
          boardConfigs={boardConfigs}
          placement="top"
          onBoardSelected={handleCustomSelect}
        />
      )}
    </>
  );
}
