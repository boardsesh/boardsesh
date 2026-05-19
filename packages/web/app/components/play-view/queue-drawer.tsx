'use client';

import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MuiButton from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import DeleteOutlined from '@mui/icons-material/DeleteOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import HistoryOutlined from '@mui/icons-material/HistoryOutlined';
import { useQueueActions, useQueueList, useSessionData } from '../graphql-queue';
import QueueList, { type QueueListHandle } from '../queue-control/queue-list';
import CurrentlyOnBoardHeader from '../board-history/currently-on-board-header';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import { usePullToClose } from '@/app/lib/hooks/pull-to-close';
import { useDrawerDragResize } from '@/app/hooks/use-drawer-drag-resize';
import { themeTokens } from '@/app/theme/theme-config';
import type { BoardDetails } from '@/app/lib/types';
import styles from './play-view-drawer.module.css';
import drawerStyles from '../swipeable-drawer/swipeable-drawer.module.css';

const QUEUE_DRAWER_STYLES = {
  wrapper: {
    touchAction: 'pan-y' as const,
    transition: 'height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
  },
  body: { padding: 0, overflow: 'hidden' as const, touchAction: 'pan-y' as const },
} as const;

export type QueueDrawerProps = {
  open: boolean;
  onClose: () => void;
  onTransitionEnd?: (open: boolean) => void;
  boardDetails: BoardDetails;
  /**
   * When true, history (climbs queued before the current one) is visible on
   * mount. Useful for the onboarding tour so the user sees every climb they
   * queued regardless of which one is currently active.
   */
  initialShowHistory?: boolean;
};

const QueueDrawer: React.FC<QueueDrawerProps> = ({
  open,
  onClose,
  onTransitionEnd,
  boardDetails,
  initialShowHistory = false,
}) => {
  const { t } = useTranslation('session');
  // Internal state
  const [isEditMode, setIsEditMode] = useState(false);
  const [showHistory, setShowHistory] = useState(initialShowHistory);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());

  // Refs
  const queueListRef = useRef<QueueListHandle>(null);
  const queueScrollRef = useRef<HTMLDivElement>(null);
  const [queueScrollEl, setQueueScrollEl] = useState<HTMLDivElement | null>(null);

  const queueScrollCallbackRef = useCallback((node: HTMLDivElement | null) => {
    queueScrollRef.current = node;
    setQueueScrollEl(node);
  }, []);

  // Context hooks
  const { queue } = useQueueList();
  const { setQueue } = useQueueActions();
  const { viewOnlyMode } = useSessionData();

  // Handlers
  const handleToggleSelect = useCallback((uuid: string) => {
    setSelectedItems((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) {
        next.delete(uuid);
      } else {
        next.add(uuid);
      }
      return next;
    });
  }, []);

  const handleExitEditMode = useCallback(() => {
    setIsEditMode(false);
    setSelectedItems(new Set());
  }, []);

  const handleBulkRemove = useCallback(() => {
    setQueue(queue.filter((item) => !selectedItems.has(item.uuid)));
    setSelectedItems(new Set());
    setIsEditMode(false);
  }, [queue, selectedItems, setQueue]);

  const closeDrawer = useCallback(() => {
    setIsEditMode(false);
    setSelectedItems(new Set());
    setShowHistory(false);
    onClose();
  }, [onClose]);

  const { paperRef: queuePaperRef, dragHandlers } = useDrawerDragResize({
    open,
    onClose: closeDrawer,
    scrollElement: queueScrollEl,
  });

  // Swipe-to-close on queue scroll container
  const queuePull = usePullToClose({
    paperEl: queuePaperRef.current,
    onClose: closeDrawer,
  });

  const handleQueueSwipeStart = useCallback(
    (e: React.TouchEvent) => {
      queuePull.onTouchStart(e.touches[0].clientY, queueScrollRef.current);
    },
    [queuePull],
  );

  const handleQueueSwipeMove = useCallback(
    (e: React.TouchEvent) => {
      queuePull.onTouchMove(e.touches[0].clientY, e.touches.length);
    },
    [queuePull],
  );

  const handleQueueSwipeEnd = useCallback(() => {
    queuePull.onTouchEnd();
  }, [queuePull]);

  // Transition end handler
  const handleTransitionEnd = useCallback(
    (transitionOpen: boolean) => {
      if (transitionOpen) {
        // Clear any leftover inline styles from a custom pull-to-close gesture
        if (queuePaperRef.current) {
          queuePaperRef.current.style.transform = '';
          queuePaperRef.current.style.transition = '';
        }
        setTimeout(() => {
          queueListRef.current?.scrollToCurrentClimb();
        }, 100);
      }
      // Always propagate to parent for lifecycle management
      onTransitionEnd?.(transitionOpen);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queuePaperRef is a stable ref
    [onTransitionEnd],
  );

  return (
    <SwipeableDrawer
      placement="bottom"
      height="60%"
      paperRef={queuePaperRef}
      open={open}
      showCloseButton={false}
      swipeEnabled={false}
      showDragHandle={false}
      disablePortal
      onClose={closeDrawer}
      onTransitionEnd={handleTransitionEnd}
      styles={QUEUE_DRAWER_STYLES}
    >
      {/* Custom drag header — resize only on deliberate drag, not scroll */}
      <div className={styles.queueDragHeader} data-swipe-blocked="" {...dragHandlers}>
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
            {t('queueDrawer.title')}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {queue.length > 0 &&
              !viewOnlyMode &&
              (isEditMode ? (
                <Stack direction="row" spacing={1}>
                  <MuiButton
                    variant="text"
                    startIcon={<DeleteOutlined />}
                    sx={{ color: 'var(--neutral-400)' }}
                    onClick={() => {
                      setQueue([]);
                      handleExitEditMode();
                    }}
                  >
                    {t('queueDrawer.clear')}
                  </MuiButton>
                  <IconButton onClick={handleExitEditMode}>
                    <CloseOutlined />
                  </IconButton>
                </Stack>
              ) : (
                <Stack direction="row" spacing={1}>
                  <IconButton
                    color="default"
                    onClick={() => setShowHistory((prev) => !prev)}
                    sx={showHistory ? { border: '1px solid', borderColor: 'divider' } : undefined}
                  >
                    <HistoryOutlined />
                  </IconButton>
                  <IconButton onClick={() => setIsEditMode(true)}>
                    <EditOutlined />
                  </IconButton>
                </Stack>
              ))}
          </Box>
        </Box>
      </div>
      <div className={styles.queueBodyLayout}>
        <div
          ref={queueScrollCallbackRef}
          className={styles.queueScrollContainer}
          style={{ touchAction: 'pan-y' }}
          onTouchStart={handleQueueSwipeStart}
          onTouchMove={handleQueueSwipeMove}
          onTouchEnd={handleQueueSwipeEnd}
        >
          {/* Read-only "Currently on the board" header pinned at the top of
              the scroll container. Stays visible as the queue list scrolls
              so users can always see what the wall is actually showing. */}
          <Box
            sx={{
              position: 'sticky',
              top: 0,
              zIndex: 1,
              backgroundColor: 'background.paper',
            }}
          >
            <CurrentlyOnBoardHeader />
          </Box>
          {/* Small label so the distinction between "what's on the board"
              and "your queue" is unambiguous. */}
          <Typography
            variant="overline"
            component="div"
            sx={{
              px: `${themeTokens.spacing[3]}px`,
              pt: 1,
              pb: 0.25,
              color: 'text.secondary',
              fontWeight: themeTokens.typography.fontWeight.medium,
              lineHeight: themeTokens.typography.lineHeight.tight,
            }}
          >
            {t('queueDrawer.yourQueue.label')}
          </Typography>
          <QueueList
            ref={queueListRef}
            boardDetails={boardDetails}
            isEditMode={isEditMode}
            showHistory={showHistory}
            selectedItems={selectedItems}
            onToggleSelect={handleToggleSelect}
            scrollContainer={queueScrollEl}
          />
        </div>
        {isEditMode && selectedItems.size > 0 && (
          <div className={styles.bulkRemoveBar}>
            <MuiButton variant="contained" color="error" fullWidth onClick={handleBulkRemove}>
              {t('queueDrawer.removeItems', { count: selectedItems.size })}
            </MuiButton>
          </div>
        )}
      </div>
    </SwipeableDrawer>
  );
};

export default React.memo(QueueDrawer);
