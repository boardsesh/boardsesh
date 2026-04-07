'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import LoginOutlined from '@mui/icons-material/LoginOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import PlayCircleOutlineOutlined from '@mui/icons-material/PlayCircleOutlineOutlined';
import CircularProgress from '@mui/material/CircularProgress';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import SessionCreationForm from './session-creation-form';
import type { SessionCreationFormData } from './session-creation-form';
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
import { useMyBoards } from '@/app/hooks/use-my-boards';
import { BoardConfigData } from '@/app/lib/server-board-configs';
import type { StoredBoardConfig } from '@/app/lib/saved-boards-db';
import type { UserBoard, PopularBoardConfig } from '@boardsesh/shared-schema';
import type { BoardName } from '@/app/lib/types';

interface StartSeshDrawerProps {
  open: boolean;
  onClose: () => void;
  onTransitionEnd?: (open: boolean) => void;
  boardConfigs?: BoardConfigData;
}

export default function StartSeshDrawer({ open, onClose, onTransitionEnd, boardConfigs }: StartSeshDrawerProps) {
  const { status } = useSession();
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

      if (
        localBoardPath &&
        (localQueue.length > 0 || localCurrentClimbQueueItem) &&
        getBaseBoardPath(localBoardPath) === getBaseBoardPath(boardPath)
      ) {
        setInitialQueueForSession(sessionId, localQueue, localCurrentClimbQueueItem, formData.name);
      }

      setClimbSessionCookie(sessionId);

      if (localBoardPath && localBoardDetails && getBaseBoardPath(localBoardPath) === getBaseBoardPath(boardPath)) {
        const angle = selectedBoard?.angle ?? selectedCustomConfig?.angle ?? 0;
        activateSession({
          sessionId,
          sessionName: formData.name,
          boardPath: localBoardPath,
          boardDetails: localBoardDetails,
          parsedParams: {
            board_name: localBoardDetails.board_name,
            layout_id: localBoardDetails.layout_id,
            size_id: localBoardDetails.size_id,
            set_ids: localBoardDetails.set_ids,
            angle,
          },
        });
      }

      router.push(navigateUrl);

      handleClose();
      showMessage('Session started!', 'success');
    } catch (error) {
      console.error('Failed to create session:', error);
      showMessage('Failed to start session', 'error');
      throw error;
    }
  };

  const hasSelection = selectedBoard || selectedCustomConfig;
  const selectedName = selectedBoard?.name ?? selectedCustomConfig?.name;

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
        title="Start session"
        placement="top"
        fullHeight
        open={open}
        onClose={handleClose}
        onTransitionEnd={onTransitionEnd}
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
          hideNearby
          showCreateBoard
          startWithForm
        />
      )}
    </>
  );
}
