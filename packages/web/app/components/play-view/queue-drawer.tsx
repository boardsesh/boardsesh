'use client';

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MuiButton from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import EditOutlined from '@mui/icons-material/EditOutlined';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import Lightbulb from '@mui/icons-material/Lightbulb';
import { useQueueActions, useQueueData, useQueueList, useSessionData } from '../graphql-queue';
import QueueList, { type QueueListHandle } from '../queue-control/queue-list';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import { usePullToClose } from '@/app/lib/hooks/pull-to-close';
import { useDrawerDragResize } from '@/app/hooks/use-drawer-drag-resize';
import { themeTokens } from '@/app/theme/theme-config';
import type { BoardDetails } from '@/app/lib/types';
import type { ClimbQueueItem } from '../queue-control/types';
import styles from './play-view-drawer.module.css';
import drawerStyles from '../swipeable-drawer/swipeable-drawer.module.css';

const QUEUE_DRAWER_STYLES = {
  wrapper: {
    touchAction: 'pan-y' as const,
    transition: 'height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
  },
  body: { padding: 0, overflow: 'hidden' as const, touchAction: 'pan-y' as const },
} as const;

type QueueScope =
  | { type: 'mine'; key: 'mine'; label: string }
  | { type: 'all'; key: 'all'; label: string }
  | { type: 'user'; key: string; label: string; userIds: string[] };

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

const QueueDrawer: React.FC<QueueDrawerProps> = ({ open, onClose, onTransitionEnd, boardDetails }) => {
  const { t } = useTranslation('session');
  // Internal state
  const [isEditMode, setIsEditMode] = useState(false);
  const [showPlanAhead, setShowPlanAhead] = useState(false);
  const [activeScopeKey, setActiveScopeKey] = useState<string>('mine');
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
  const { boardSends } = useQueueData();
  const { removeFromQueue, reorderQueueItem, setQueue } = useQueueActions();
  const { viewOnlyMode, users, clientId } = useSessionData();

  const myUserIds = useMemo(() => {
    const ids = new Set<string>();
    if (clientId) ids.add(clientId);
    const me = users.find((user) => user.id === clientId);
    if (me?.userId) ids.add(me.userId);
    return ids;
  }, [clientId, users]);

  const getOwnerIds = useCallback((item: ClimbQueueItem): string[] => {
    return [item.addedBy ?? null, item.addedByUser?.id ?? null].filter((id): id is string => !!id);
  }, []);

  const isMine = useCallback(
    (item: ClimbQueueItem): boolean => getOwnerIds(item).some((id) => myUserIds.has(id)),
    [getOwnerIds, myUserIds],
  );

  const scopeOptions = useMemo<QueueScope[]>(() => {
    const options: QueueScope[] = [
      { type: 'mine', key: 'mine', label: 'My queue' },
      { type: 'all', key: 'all', label: 'All' },
    ];
    users.forEach((user) => {
      const userIds = [user.id, user.userId].filter((id): id is string => !!id);
      if (userIds.some((id) => myUserIds.has(id))) return;
      options.push({ type: 'user', key: `user:${userIds[0]}`, label: user.username, userIds });
    });
    return options;
  }, [myUserIds, users]);

  const activeScope = scopeOptions.find((scope) => scope.key === activeScopeKey) ?? scopeOptions[0];
  const scopedQueue = useMemo(() => {
    if (activeScope.type === 'all') return queue;
    if (activeScope.type === 'mine') return queue.filter(isMine);
    const ids = new Set(activeScope.userIds);
    return queue.filter((item) => getOwnerIds(item).some((id) => ids.has(id)));
  }, [activeScope, getOwnerIds, isMine, queue]);

  const sentHistory = useMemo(() => {
    const seen = new Set<string>();
    return boardSends.filter((send) => {
      if (seen.has(send.climbUuid)) return false;
      seen.add(send.climbUuid);
      return true;
    });
  }, [boardSends]);

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
    scopedQueue.filter((item) => selectedItems.has(item.uuid) && isMine(item)).forEach((item) => removeFromQueue(item));
    setSelectedItems(new Set());
    setIsEditMode(false);
  }, [isMine, removeFromQueue, scopedQueue, selectedItems]);

  const closeDrawer = useCallback(() => {
    setIsEditMode(false);
    setSelectedItems(new Set());
    setShowPlanAhead(false);
    onClose();
  }, [onClose]);

  const handleReorderItems = useCallback(
    (item: ClimbQueueItem, _scopedOldIndex: number, scopedNewIndex: number, nextScopedQueue: ClimbQueueItem[]) => {
      const oldIndex = queue.findIndex((queueItem) => queueItem.uuid === item.uuid);
      const destinationItem = nextScopedQueue[scopedNewIndex] ?? nextScopedQueue[nextScopedQueue.length - 1];
      const newIndex = destinationItem ? queue.findIndex((queueItem) => queueItem.uuid === destinationItem.uuid) : -1;
      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
      if (reorderQueueItem) {
        reorderQueueItem(item.uuid, oldIndex, newIndex);
        return;
      }
      const nextQueue = [...queue];
      const [moved] = nextQueue.splice(oldIndex, 1);
      nextQueue.splice(newIndex, 0, moved);
      setQueue(nextQueue);
    },
    [queue, reorderQueueItem, setQueue],
  );

  const selectedOwnCount = scopedQueue.filter((item) => selectedItems.has(item.uuid) && isMine(item)).length;
  const hasEditableRows = scopedQueue.some(isMine);

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
                  <IconButton onClick={handleExitEditMode}>
                    <CloseOutlined />
                  </IconButton>
                </Stack>
              ) : (
                <Stack direction="row" spacing={1}>
                  <IconButton disabled={!hasEditableRows} onClick={() => setIsEditMode(true)}>
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
          <Box sx={{ padding: `${themeTokens.spacing[3]}px ${themeTokens.spacing[4]}px` }}>
            <Stack spacing={1.5}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                Sent to board
              </Typography>
              {sentHistory.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No climbs sent yet.
                </Typography>
              ) : (
                <Stack spacing={1}>
                  {sentHistory.slice(0, showPlanAhead ? 4 : 12).map((send) => (
                    <Box
                      key={send.id}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1,
                        border: '1px solid var(--neutral-200)',
                        borderRadius: '8px',
                        padding: `${themeTokens.spacing[2]}px ${themeTokens.spacing[3]}px`,
                        backgroundColor: 'var(--semantic-surface)',
                      }}
                    >
                      <Lightbulb sx={{ fontSize: 16, color: themeTokens.colors.primary }} />
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
                          {send.item.climb.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {send.item.climb.difficulty}
                        </Typography>
                      </Box>
                    </Box>
                  ))}
                </Stack>
              )}
              <MuiButton
                variant={showPlanAhead ? 'text' : 'outlined'}
                size="small"
                onClick={() => setShowPlanAhead((prev) => !prev)}
              >
                {showPlanAhead ? 'Hide plan ahead' : 'Plan ahead'}
              </MuiButton>
            </Stack>
          </Box>
          {showPlanAhead && (
            <Box sx={{ borderTop: '1px solid var(--neutral-200)' }}>
              <Stack
                direction="row"
                spacing={1}
                sx={{
                  overflowX: 'auto',
                  padding: `${themeTokens.spacing[2]}px ${themeTokens.spacing[4]}px`,
                }}
              >
                {scopeOptions.map((scope) => (
                  <MuiButton
                    key={scope.key}
                    size="small"
                    variant={scope.key === activeScope.key ? 'contained' : 'outlined'}
                    onClick={() => {
                      setActiveScopeKey(scope.key);
                      setSelectedItems(new Set());
                      setIsEditMode(false);
                    }}
                    sx={{ whiteSpace: 'nowrap' }}
                  >
                    {scope.label}
                  </MuiButton>
                ))}
              </Stack>
              {scopedQueue.length === 0 ? (
                <Box sx={{ padding: `${themeTokens.spacing[2]}px ${themeTokens.spacing[4]}px` }}>
                  <Typography variant="body2" color="text.secondary">
                    No queued climbs.
                  </Typography>
                </Box>
              ) : (
                <QueueList
                  ref={queueListRef}
                  boardDetails={boardDetails}
                  isEditMode={isEditMode}
                  showHistory={false}
                  selectedItems={selectedItems}
                  onToggleSelect={handleToggleSelect}
                  scrollContainer={queueScrollEl}
                  scopedQueue={scopedQueue}
                  planMode
                  active
                  canMutateItem={isMine}
                  onReorderItems={handleReorderItems}
                />
              )}
            </Box>
          )}
        </div>
        {isEditMode && selectedOwnCount > 0 && (
          <div className={styles.bulkRemoveBar}>
            <MuiButton variant="contained" color="error" fullWidth onClick={handleBulkRemove}>
              {t('queueDrawer.removeItems', { count: selectedOwnCount })}
            </MuiButton>
          </div>
        )}
      </div>
    </SwipeableDrawer>
  );
};

export default React.memo(QueueDrawer);
