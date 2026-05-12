'use client';

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { track } from '@/app/lib/analytics';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import LoginOutlined from '@mui/icons-material/LoginOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import PlayCircleOutlineOutlined from '@mui/icons-material/PlayCircleOutlineOutlined';
import AutoFixHighOutlined from '@mui/icons-material/AutoFixHighOutlined';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import drawerCss from '../swipeable-drawer/swipeable-drawer.module.css';
import { useDrawerDragResize } from '@/app/hooks/use-drawer-drag-resize';
import { themeTokens } from '@/app/theme/theme-config';
import SessionCreationForm, { type SessionCreationFormData } from './session-creation-form';
import BoardSelectorDrawer from '@/app/components/board-selector-drawer/board-selector-drawer';
import BoardDiscoveryScroll from '@/app/components/board-scroll/board-discovery-scroll';
import BoardScrollCard from '@/app/components/board-scroll/board-scroll-card';
import { WorkoutGeneratorDrawer, type GeneratorTarget, type WorkoutType } from '@/app/components/workout-generator';
import { useCreateSession } from '@/app/hooks/use-create-session';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { useSession } from 'next-auth/react';
import { usePathname } from 'next/navigation';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import { useTranslation } from 'react-i18next';
import {
  constructBoardSlugListUrl,
  getBaseBoardPath,
  constructClimbListWithSlugs,
  tryConstructSlugListUrl,
} from '@/app/lib/url-utils';
import { getDefaultAngleForBoard } from '@/app/lib/board-config-for-playlist';
import { getBoardDetails } from '@/app/lib/board-constants';
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
import type { BoardName, BoardDetails, Climb } from '@/app/lib/types';
import type { ClimbQueueItem as LocalClimbQueueItem } from '@/app/components/queue-control/types';

type StartSeshDrawerProps = {
  open: boolean;
  onClose: () => void;
  onTransitionEnd?: (open: boolean) => void;
  boardConfigs?: BoardConfigData;
};

export default function StartSeshDrawer({ open, onClose, onTransitionEnd, boardConfigs }: StartSeshDrawerProps) {
  const { t } = useTranslation('session');
  const { status } = useSession();
  // Keep the drawer at full height — pin both heights so the close handler
  // doesn't reset the inline style back to 60% (the hook's default), which
  // would override the `height="100%"` prop on the next open.
  const { paperRef, dragHandlers } = useDrawerDragResize({
    open,
    onClose,
    initialHeight: '100%',
    expandedHeight: '100%',
  });
  const router = useLocaleRouter();
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
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [generatedClimbs, setGeneratedClimbs] = useState<Climb[]>([]);
  const [generatedWorkoutType, setGeneratedWorkoutType] = useState<WorkoutType | null>(null);
  const hasAutoSelectedRef = useRef(false);
  const formSubmitRef = useRef<(() => void) | null>(null);

  // Reset auto-selection tracking and expander state when the drawer closes.
  // handleClose covers user-initiated closes, but the parent can also flip
  // `open` to false directly (navigation, external dismiss) — in that case
  // we still need to drop the expanded state so the next open isn't stale.
  useEffect(() => {
    if (!open) {
      hasAutoSelectedRef.current = false;
      setBoardSelectorExpanded(false);
      setGeneratorOpen(false);
      setGeneratedClimbs([]);
      setGeneratedWorkoutType(null);
    }
  }, [open]);

  // Auto-select the current board when the drawer opens.
  //
  // Named-board routes (/b/{slug}) auto-select the named UserBoard so the
  // session is attributed to that specific board. Generic routes
  // (/{board}/{layout}/{size}/{sets}/{angle}/...) auto-select a *custom*
  // config built from the route's resolved details — we deliberately do NOT
  // match a UserBoard with the same numeric identity, because the same
  // layout/size/set combo can map to many different physical boards and
  // attributing a generic-URL session to a named board would silently log
  // climbs against the wrong board.
  useEffect(() => {
    if (!open || hasAutoSelectedRef.current) return;

    // Prefer the current pathname over the persistent session's last route —
    // the user's intent is whatever they're looking at now.
    const effectivePathname = pathname && isBoardRoutePath(pathname) ? pathname : localBoardPath;
    if (!effectivePathname) {
      hasAutoSelectedRef.current = true;
      return;
    }

    // Named-board route → select the matching UserBoard by slug.
    if (effectivePathname.startsWith('/b/')) {
      if (boards.length === 0) return; // wait for boards to load
      const basePath = getBaseBoardPath(effectivePathname);
      const namedMatch = boards.find((b) => `/b/${b.slug}` === basePath);
      hasAutoSelectedRef.current = true;
      if (namedMatch) setSelectedBoard(namedMatch);
      return;
    }

    // Generic board route → build a custom config from the route's resolved
    // board details (bridge for the current route, fall back to the session).
    const effectiveBoardDetails = bridgeBoardDetails ?? localBoardDetails;
    if (!effectiveBoardDetails) return; // wait for details to resolve

    const angle = bridgeAngle ?? getDefaultAngleForBoard(effectiveBoardDetails.board_name);
    const displayName =
      effectiveBoardDetails.layout_name && effectiveBoardDetails.size_name
        ? [effectiveBoardDetails.layout_name, effectiveBoardDetails.size_name].filter(Boolean).join(' · ')
        : `${effectiveBoardDetails.board_name.charAt(0).toUpperCase()}${effectiveBoardDetails.board_name.slice(1)}`;

    setSelectedCustomPath(effectivePathname);
    setSelectedCustomConfig({
      name: displayName,
      board: effectiveBoardDetails.board_name,
      layoutId: effectiveBoardDetails.layout_id,
      sizeId: effectiveBoardDetails.size_id,
      setIds: [...effectiveBoardDetails.set_ids],
      angle,
      createdAt: new Date().toISOString(),
    });
    hasAutoSelectedRef.current = true;
  }, [open, boards, localBoardPath, localBoardDetails, bridgeBoardDetails, bridgeAngle, pathname]);

  const isLoggedIn = status === 'authenticated';

  const handleClose = useCallback(() => {
    onClose();
    setSelectedBoard(null);
    setSelectedCustomPath(null);
    setSelectedCustomConfig(null);
    setBoardSelectorExpanded(false);
    setGeneratedClimbs([]);
    setGeneratedWorkoutType(null);
    setFormKey((k) => k + 1);
  }, [onClose]);

  // The generator's output is tied to a specific board — if the user switches
  // boards after generating, drop the generated queue. Using a ref to skip the
  // first render (auto-selection populating the board) so we don't wipe state
  // on the initial assignment.
  const lastGeneratorBoardKeyRef = useRef<string | null>(null);
  const generatorBoardKey = selectedBoard?.uuid ?? selectedCustomPath ?? null;
  useEffect(() => {
    if (lastGeneratorBoardKeyRef.current !== null && lastGeneratorBoardKeyRef.current !== generatorBoardKey) {
      if (generatedClimbs.length > 0 || generatedWorkoutType) {
        setGeneratedClimbs([]);
        setGeneratedWorkoutType(null);
      }
    }
    lastGeneratorBoardKeyRef.current = generatorBoardKey;
  }, [generatorBoardKey, generatedClimbs.length, generatedWorkoutType]);

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

  // Resolve the BoardDetails + angle for whichever board the user has picked.
  // The generator needs both. Returns null when nothing is selected yet
  // (button stays disabled) or when getBoardDetails throws for an exotic
  // combination we can't render.
  const generatorContext = useMemo<{ boardDetails: BoardDetails; angle: number } | null>(() => {
    if (selectedBoard) {
      try {
        const setIds = selectedBoard.setIds
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map(Number);
        const boardDetails = getBoardDetails({
          board_name: selectedBoard.boardType as BoardName,
          layout_id: selectedBoard.layoutId,
          size_id: selectedBoard.sizeId,
          set_ids: setIds,
        });
        return { boardDetails, angle: selectedBoard.angle };
      } catch {
        return null;
      }
    }
    if (selectedCustomConfig) {
      try {
        const boardDetails = getBoardDetails({
          board_name: selectedCustomConfig.board,
          layout_id: selectedCustomConfig.layoutId,
          size_id: selectedCustomConfig.sizeId,
          set_ids: selectedCustomConfig.setIds,
        });
        return { boardDetails, angle: selectedCustomConfig.angle };
      } catch {
        return null;
      }
    }
    return null;
  }, [selectedBoard, selectedCustomConfig]);

  // Session target: drawer accumulates climbs internally and hands the final
  // list to onComplete. saveClimb is a no-op — there is no session yet, so we
  // can't write anywhere durable. The full list is stored locally and committed
  // to the new session's initial queue inside handleSubmit.
  const sessionGeneratorTarget = useMemo<GeneratorTarget>(
    () => ({
      saveClimb: async () => {
        // intentional no-op — see comment above
      },
      onComplete: (savedClimbs, meta) => {
        if (savedClimbs.length === 0) return;
        setGeneratedClimbs(savedClimbs);
        setGeneratedWorkoutType(meta.workoutType);
        track('Session Queue Generated', {
          workoutType: meta.workoutType,
          boardName: generatorContext?.boardDetails.board_name ?? '',
          angle: generatorContext?.angle ?? 0,
          savedCount: savedClimbs.length,
          failedCount: meta.failed,
        });
      },
    }),
    [generatorContext],
  );

  const handleClearGeneratedQueue = useCallback(() => {
    if (generatedClimbs.length === 0) return;
    track('Session Queue Generated Cleared', {
      workoutType: generatedWorkoutType,
      savedCount: generatedClimbs.length,
      boardName: generatorContext?.boardDetails.board_name ?? '',
    });
    setGeneratedClimbs([]);
    setGeneratedWorkoutType(null);
  }, [generatedClimbs.length, generatedWorkoutType, generatorContext]);

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
      showMessage(t('creation.selectBoardWarning'), 'warning');
      return;
    }

    try {
      const sessionId = await createSession(formData, boardPath);

      // Effective values: prefer local state, fall back to bridge context.
      // Local state may be empty when the QueueBridgeInjector is active on a
      // board route — it only syncs to local state on cleanup (navigating away).
      const effectiveBoardDetails = localBoardDetails ?? bridgeBoardDetails;
      let effectiveBaseBoardPath: string | null;
      if (localBoardPath) {
        effectiveBaseBoardPath = getBaseBoardPath(localBoardPath);
      } else if (bridgeBoardDetails && pathname) {
        effectiveBaseBoardPath = getBaseBoardPath(pathname);
      } else {
        effectiveBaseBoardPath = null;
      }
      const effectiveQueue = localQueue.length > 0 ? localQueue : bridgeQueue;
      const effectiveCurrentClimb = localCurrentClimbQueueItem ?? bridgeCurrentClimbQueueItem;
      const boardsMatch = effectiveBaseBoardPath != null && effectiveBaseBoardPath === getBaseBoardPath(boardPath);

      // If the user generated a workout queue inside the drawer, that is their
      // explicit intent — use it and skip any carryover. Otherwise fall back
      // to transferring the existing local/bridge queue if the boards match.
      if (generatedClimbs.length > 0) {
        const generatedQueueItems: LocalClimbQueueItem[] = generatedClimbs.map((climb) => ({
          climb,
          uuid: uuidv4(),
        }));
        setInitialQueueForSession(sessionId, generatedQueueItems, null, formData.name);
      } else if (boardsMatch && (effectiveQueue.length > 0 || effectiveCurrentClimb)) {
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
        generatedQueueCount: generatedClimbs.length,
        generatedWorkoutType: generatedWorkoutType ?? undefined,
      });

      handleClose();
      showMessage(t('creation.started'), 'success');
    } catch (error) {
      console.error('Failed to create session:', error);
      showMessage(t('creation.errors.createFailed'), 'error');
      throw error;
    }
  };

  const hasSelection = selectedBoard || selectedCustomConfig;

  const showCollapsed = !!hasSelection && !boardSelectorExpanded;

  const boardSelector = (
    <Box>
      <Typography sx={{ fontSize: 16, fontWeight: 600, color: 'text.primary', mb: 1.5 }}>
        {t('creation.boardsNearYou')}
      </Typography>
      <Collapse in={showCollapsed} mountOnEnter unmountOnExit>
        <Box
          data-testid="selected-board-card"
          sx={{ position: 'relative', width: 'fit-content', mb: 1, cursor: 'pointer' }}
          onClick={() => setBoardSelectorExpanded(true)}
        >
          <BoardScrollCard
            userBoard={selectedBoard ?? undefined}
            storedConfig={selectedCustomConfig ?? undefined}
            boardConfigs={boardConfigs}
            selected
            size="collapsed"
            onClick={() => setBoardSelectorExpanded(true)}
          />
          {/* Grey overlay + edit icon — pointerEvents:none so clicks pass through to the card */}
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              aspectRatio: 1,
              borderRadius: '6px',
              bgcolor: themeTokens.semantic.overlayLight,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
            }}
          >
            <EditOutlined sx={{ color: 'common.white', fontSize: 20 }} />
          </Box>
        </Box>
      </Collapse>
      {!showCollapsed && (
        <BoardDiscoveryScroll
          onBoardClick={handleDiscoveryBoardClick}
          onConfigClick={handleConfigClick}
          onCustomClick={() => setShowBoardDrawer(true)}
          selectedBoardUuid={selectedBoard?.uuid}
          myBoards={boards}
          hideTitle
        />
      )}
      {boardsError && (
        <Typography variant="body2" color="error" sx={{ mt: 0.5 }}>
          {boardsError}
        </Typography>
      )}
    </Box>
  );

  const canOpenGenerator = !!generatorContext;
  const queuePlannerSection = (
    <Box>
      {generatedClimbs.length > 0 ? (
        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          sx={{
            p: 1.25,
            borderRadius: 1,
            border: `1px solid ${themeTokens.colors.primary}`,
            bgcolor: themeTokens.semantic.selectedLight,
          }}
        >
          <AutoFixHighOutlined fontSize="small" sx={{ color: 'primary.main' }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {t('creation.generator.summary', { count: generatedClimbs.length })}
            </Typography>
          </Box>
          <Button size="small" variant="text" onClick={() => setGeneratorOpen(true)} disabled={!canOpenGenerator}>
            {t('creation.generator.regenerate')}
          </Button>
          <IconButton size="small" onClick={handleClearGeneratedQueue} aria-label={t('creation.generator.clear')}>
            <CloseOutlined fontSize="small" />
          </IconButton>
        </Stack>
      ) : (
        <Button
          variant="outlined"
          fullWidth
          startIcon={<AutoFixHighOutlined />}
          onClick={() => setGeneratorOpen(true)}
          disabled={!canOpenGenerator}
        >
          {canOpenGenerator ? t('creation.generator.openButton') : t('creation.generator.openButtonHint')}
        </Button>
      )}
    </Box>
  );

  const combinedHeaderContent = (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {boardSelector}
      {queuePlannerSection}
    </Box>
  );

  return (
    <>
      <SwipeableDrawer
        title={
          <div data-swipe-blocked="" {...dragHandlers} className={drawerCss.dragHeaderWrapper}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              {t('creation.drawerTitle')}
            </Typography>
          </div>
        }
        placement="bottom"
        height="100%"
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
          body: { padding: `${themeTokens.spacing[2]}px ${themeTokens.spacing[3]}px` },
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
            {t('creation.submitDefault')}
          </Button>
        }
      >
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Typography variant="body2" component="span">
            {isLoggedIn ? t('creation.loggedInBlurb') : t('creation.anonymousBlurb')}
          </Typography>
          <SessionCreationForm
            key={formKey}
            onSubmit={handleSubmit}
            isSubmitting={isCreating}
            submitLabel={t('creation.submitDefault')}
            headerContent={combinedHeaderContent}
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
                  title: t('creation.signInModalTitle'),
                  description: t('creation.signInModalDescription'),
                })
              }
              sx={{ alignSelf: 'center' }}
            >
              {t('creation.signInForMore')}
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

      {generatorContext && (
        <WorkoutGeneratorDrawer
          open={generatorOpen}
          onClose={() => setGeneratorOpen(false)}
          boardDetails={generatorContext.boardDetails}
          angle={generatorContext.angle}
          target={sessionGeneratorTarget}
          targetType="session"
        />
      )}
    </>
  );
}
