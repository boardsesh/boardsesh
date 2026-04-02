'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import MuiButton from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import DeleteOutlined from '@mui/icons-material/DeleteOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import CloseOutlined from '@mui/icons-material/CloseOutlined';
import HistoryOutlined from '@mui/icons-material/HistoryOutlined';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { useQueueContext } from '../graphql-queue';
import { ClimbActions } from '../climb-actions';
import PlaylistSelectionContent from '../climb-actions/playlist-selection-content';
import QueueList, { QueueListHandle } from '../queue-control/queue-list';
import { useWakeLock } from '../board-bluetooth-control/use-wake-lock';
import { themeTokens } from '@/app/theme/theme-config';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import { LogAscentDrawer } from '../logbook/log-ascent-drawer';
import type { ActiveDrawer } from '../queue-control/queue-control-bar';
import type { BoardDetails, Angle, Climb } from '@/app/lib/types';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import styles from './play-view-drawer.module.css';
import drawerStyles from '../swipeable-drawer/swipeable-drawer.module.css';
import ClimbDetailShellClient from '@/app/components/climb-detail/climb-detail-shell.client';
import { useBuildClimbDetailSections } from '@/app/components/climb-detail/build-climb-detail-sections';
import PlayClimbAboveFold from './play-climb-above-fold';



interface PlayDrawerContentProps {
  climb: Climb;
  boardType: string;
  angle: number;
  aboveFold: React.ReactNode;
}

const PlayDrawerContent: React.FC<PlayDrawerContentProps> = ({ climb, boardType, angle, aboveFold }) => {
  const sections = useBuildClimbDetailSections({
    climb,
    climbUuid: climb.uuid,
    boardType,
    angle,
    currentClimbDifficulty: climb.difficulty ?? undefined,
    boardName: boardType,
  });

  return <ClimbDetailShellClient mode="play" sections={sections} aboveFold={aboveFold} />;
};

interface PlayViewDrawerProps {
  activeDrawer: ActiveDrawer;
  setActiveDrawer: (drawer: ActiveDrawer) => void;
  boardDetails: BoardDetails;
  angle: Angle;
}


const PlayViewDrawer: React.FC<PlayViewDrawerProps> = ({
  activeDrawer,
  setActiveDrawer,
  boardDetails,
  angle,
}) => {
  const isOpen = activeDrawer === 'play';
  const [isActionsOpen, setIsActionsOpen] = useState(false);
  const [isQueueOpen, setIsQueueOpen] = useState(false);
  const [isPlaylistSelectorOpen, setIsPlaylistSelectorOpen] = useState(false);
  const [isTickDrawerOpen, setIsTickDrawerOpen] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [queueDrawerHeight, setQueueDrawerHeight] = useState<string>('60%');
  const pathname = usePathname();
  const queueListRef = useRef<QueueListHandle>(null);
  const queueScrollRef = useRef<HTMLDivElement>(null);
  const [queueScrollEl, setQueueScrollEl] = useState<HTMLDivElement | null>(null);

  const queueScrollCallbackRef = useCallback((node: HTMLDivElement | null) => {
    queueScrollRef.current = node;
    setQueueScrollEl(node);
  }, []);

  const { currentClimb, queue, setQueue, viewOnlyMode } = useQueueContext();

  // Wake lock when drawer is open
  useWakeLock(isOpen);

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

  const handleBulkRemove = useCallback(() => {
    setQueue(queue.filter((item) => !selectedItems.has(item.uuid)));
    setSelectedItems(new Set());
    setIsEditMode(false);
  }, [queue, selectedItems, setQueue]);

  const handleExitEditMode = useCallback(() => {
    setIsEditMode(false);
    setSelectedItems(new Set());
  }, []);

  // Drag-to-resize handlers for queue drawer header
  const dragStartY = useRef<number>(0);
  const dragStartHeightRef = useRef<string>('60%');
  const isDragGestureRef = useRef(false);

  const handleQueueDragStart = useCallback((e: React.TouchEvent) => {
    dragStartY.current = e.touches[0].clientY;
    dragStartHeightRef.current = queueDrawerHeight;
    isDragGestureRef.current = false;
  }, [queueDrawerHeight]);

  const handleQueueDragMove = useCallback((e: React.TouchEvent) => {
    const delta = Math.abs(e.touches[0].clientY - dragStartY.current);
    if (delta > 10) {
      isDragGestureRef.current = true;
    }
  }, []);

  const handleQueueDragEnd = useCallback((e: React.TouchEvent) => {
    if (!isDragGestureRef.current) return;

    const deltaY = e.changedTouches[0].clientY - dragStartY.current;
    const THRESHOLD = 30;

    if (deltaY < -THRESHOLD) {
      // Dragged up → expand to 100%
      setQueueDrawerHeight('100%');
    } else if (deltaY > THRESHOLD) {
      if (dragStartHeightRef.current === '100%') {
        // Dragged down from 100% → collapse to 60%
        setQueueDrawerHeight('60%');
      } else {
        // Dragged down from 60% → close drawer
        setIsQueueOpen(false);
        handleExitEditMode();
        setShowHistory(false);
      }
    }
  }, [handleExitEditMode]);

  // Reset drawer height when queue drawer closes
  useEffect(() => {
    if (!isQueueOpen) {
      setQueueDrawerHeight('60%');
    }
  }, [isQueueOpen]);

  // Hash-based back button support
  useEffect(() => {
    if (!isOpen) return;

    window.history.pushState(null, '', '#playing');

    const handlePopState = () => {
      setActiveDrawer('none');
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      if (window.location.hash === '#playing') {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    };
  }, [isOpen, setActiveDrawer]);

  const handleClose = useCallback(() => {
    if (isActionsOpen || isQueueOpen || isPlaylistSelectorOpen || isTickDrawerOpen) return;
    setActiveDrawer('none');
    if (window.location.hash === '#playing') {
      window.history.back();
    }
  }, [setActiveDrawer, isActionsOpen, isQueueOpen, isPlaylistSelectorOpen, isTickDrawerOpen]);

  const currentAngle = typeof angle === 'string' ? parseInt(angle, 10) : angle;


  return (
    <SwipeableDrawer
      placement="bottom"
      height="100%"
      fullHeight
      open={isOpen}
      onClose={handleClose}
      keepMounted
      swipeEnabled={!isActionsOpen && !isQueueOpen && !isPlaylistSelectorOpen}
      showDragHandle={true}
      styles={{
        body: { padding: 0, overflow: 'hidden' },
        wrapper: { height: '100%', backgroundColor: 'var(--semantic-background)' },
      }}
    >
      <div className={styles.drawerContent}>
        {currentClimb ? (
          <PlayDrawerContent
            climb={currentClimb}
            boardType={boardDetails.board_name}
            angle={currentAngle}
            aboveFold={
              <PlayClimbAboveFold
                climb={currentClimb}
                boardDetails={boardDetails}
                angle={currentAngle}
                onOpenTick={() => setIsTickDrawerOpen(true)}
                onOpenActions={() => {
                  setIsQueueOpen(false);
                  setIsPlaylistSelectorOpen(false);
                  setIsActionsOpen(true);
                }}
                onOpenQueue={() => {
                  setIsActionsOpen(false);
                  setIsPlaylistSelectorOpen(false);
                  setIsQueueOpen(true);
                }}
              />
            }
          />
        ) : (
          <ClimbDetailShellClient mode="play" sections={[]} aboveFold={null} />
        )}
      </div>

        {/* Climb actions drawer */}
        {currentClimb && (
          <SwipeableDrawer
            title={currentClimb.name}
            placement="bottom"
            open={isActionsOpen}
            onClose={() => setIsActionsOpen(false)}
            disablePortal
            styles={{
              wrapper: { height: 'auto' },
              body: { padding: `${themeTokens.spacing[2]}px 0` },
            }}
          >
            <ClimbActions
              climb={currentClimb}
              boardDetails={boardDetails}
              angle={currentAngle}
              currentPathname={pathname}
              viewMode="list"
              onOpenPlaylistSelector={() => {
                setIsActionsOpen(false);
                setIsPlaylistSelectorOpen(true);
              }}
              onActionComplete={() => setIsActionsOpen(false)}
            />
          </SwipeableDrawer>
        )}

        {/* Playlist selector drawer */}
        {currentClimb && (
          <SwipeableDrawer
            title={currentClimb.name}
            placement="bottom"
            open={isPlaylistSelectorOpen}
            onClose={() => setIsPlaylistSelectorOpen(false)}
            disablePortal
            styles={{
              wrapper: { height: 'auto', maxHeight: '70vh' },
              body: { padding: 0 },
            }}
          >
            <PlaylistSelectionContent
              climbUuid={currentClimb.uuid}
              boardDetails={boardDetails}
              angle={currentAngle}
              onDone={() => setIsPlaylistSelectorOpen(false)}
            />
          </SwipeableDrawer>
        )}

        {/* Tick / Log Ascent drawer */}
        {currentClimb && (
          <LogAscentDrawer
            open={isTickDrawerOpen}
            onClose={() => setIsTickDrawerOpen(false)}
            currentClimb={currentClimb}
            boardDetails={boardDetails}
          />
        )}

        {/* Queue list drawer */}
        <SwipeableDrawer
          placement="bottom"
          height={queueDrawerHeight}
          open={isQueueOpen}
          showCloseButton={false}
          swipeEnabled={false}
          showDragHandle={false}
          disablePortal
          onClose={() => {
            setIsQueueOpen(false);
            handleExitEditMode();
            setShowHistory(false);
          }}
          onTransitionEnd={(open) => {
            if (open) {
              setTimeout(() => {
                queueListRef.current?.scrollToCurrentClimb();
              }, 100);
            }
          }}
          styles={{
            wrapper: {
              height: queueDrawerHeight,
              touchAction: 'pan-y',
              transition: 'height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            },
            body: { padding: 0, touchAction: 'pan-y' },
          }}
        >
          {/* Custom drag header — resize only on deliberate drag, not scroll */}
          <div
            className={styles.queueDragHeader}
            onTouchStart={handleQueueDragStart}
            onTouchMove={handleQueueDragMove}
            onTouchEnd={handleQueueDragEnd}
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
              <Typography variant="h6" component="div" sx={{ fontWeight: themeTokens.typography.fontWeight.semibold, fontSize: themeTokens.typography.fontSize.base }}>
                Queue
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {queue.length > 0 && !viewOnlyMode && (
                  isEditMode ? (
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
                        Clear
                      </MuiButton>
                      <IconButton onClick={handleExitEditMode}><CloseOutlined /></IconButton>
                    </Stack>
                  ) : (
                    <Stack direction="row" spacing={1}>
                      <IconButton
                        color={showHistory ? 'default' : 'default'}
                        onClick={() => setShowHistory((prev) => !prev)}
                        sx={showHistory ? { border: '1px solid', borderColor: 'divider' } : undefined}
                      >
                        <HistoryOutlined />
                      </IconButton>
                      <IconButton onClick={() => setIsEditMode(true)}><EditOutlined /></IconButton>
                    </Stack>
                  )
                )}
              </Box>
            </Box>
          </div>
          <div className={styles.queueBodyLayout}>
            <div 
              ref={queueScrollCallbackRef} 
              className={styles.queueScrollContainer}
              style={{ touchAction: 'pan-y' }}
            >
              <QueueList
                ref={queueListRef}
                boardDetails={boardDetails}
                onClimbNavigate={() => {
                  setIsQueueOpen(false);
                  setActiveDrawer('none');
                }}
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
                  Remove {selectedItems.size} {selectedItems.size === 1 ? 'item' : 'items'}
                </MuiButton>
              </div>
            )}
          </div>
        </SwipeableDrawer>
    </SwipeableDrawer>
  );
};

export default PlayViewDrawer;
