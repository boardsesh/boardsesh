'use client';

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import MuiTooltip from '@mui/material/Tooltip';
import MuiAvatar from '@mui/material/Avatar';
import MuiCheckbox from '@mui/material/Checkbox';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import { BoardDetails, Climb } from '@/app/lib/types';
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { DropIndicator } from '@atlaskit/pragmatic-drag-and-drop-react-drop-indicator/box';
import { attachClosestEdge, extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/types';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import BluetoothIcon from './bluetooth-icon';
import { ClimbQueueItem } from './types';
import ClimbListItem, { type SwipeActionOverride } from '../climb-card/climb-list-item';
import { themeTokens } from '@/app/theme/theme-config';
import { getGradeTintColor } from '@/app/lib/grade-colors';

type QueueClimbListItemProps = {
  item: ClimbQueueItem;
  index: number;
  isCurrent: boolean;
  isHistory: boolean;
  boardDetails: BoardDetails;
  /** Current pathname — hoisted from parent to avoid per-instance context lookups. */
  pathname: string;
  /** Whether the app is in dark mode — hoisted from parent to avoid per-instance context lookups. */
  isDark: boolean;
  setCurrentClimbQueueItem: (item: ClimbQueueItem) => void;
  onTickClick: (climb: Climb) => void;
  onOpenActions?: (climb: Climb) => void;
  onOpenPlaylistSelector?: (climb: Climb) => void;
  onThumbnailActivate?: () => void;
  isEditMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (uuid: string) => void;
};

const QueueClimbListItem: React.FC<QueueClimbListItemProps> = ({
  item,
  index,
  isCurrent,
  isHistory,
  boardDetails,
  pathname,
  isDark,
  setCurrentClimbQueueItem,
  onTickClick,
  onOpenActions,
  onOpenPlaylistSelector,
  onThumbnailActivate,
  isEditMode = false,
  isSelected = false,
  onToggleSelect,
}) => {
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const itemRef = useRef<HTMLDivElement>(null);

  // Only override swipe-left (right action) to tick instead of the default add-to-queue,
  // since these items are already in the queue. Swipe-right retains default playlist/actions.
  const swipeRightAction: SwipeActionOverride = useMemo(
    () => ({
      icon: <CheckOutlined style={{ color: 'white', fontSize: 20 }} />,
      color: themeTokens.colors.success,
      onAction: () => onTickClick(item.climb),
    }),
    [item.climb, onTickClick],
  );

  // Background color based on current/history state
  const backgroundColor = useMemo(() => {
    if (isCurrent) {
      return getGradeTintColor(item.climb.difficulty, 'light', isDark) ?? 'var(--semantic-selected)';
    }
    if (isHistory) return 'var(--neutral-100)';
    return 'var(--semantic-surface)';
  }, [isCurrent, isHistory, item.climb.difficulty, isDark]);

  // "Added by" avatar slot
  const afterTitleSlot = useMemo(() => {
    const avatarStyle = { width: 24, height: 24 };
    const avatarBluetoothStyle = { width: 24, height: 24, backgroundColor: 'transparent' };

    if (item.addedByUser) {
      return (
        <MuiTooltip title={item.addedByUser.username}>
          <MuiAvatar sx={avatarStyle} src={item.addedByUser.avatarUrl}>
            <PersonOutlined />
          </MuiAvatar>
        </MuiTooltip>
      );
    }
    return (
      <MuiTooltip title="Added via Bluetooth">
        <MuiAvatar sx={avatarBluetoothStyle}>
          <BluetoothIcon style={{ color: 'var(--neutral-400)' }} />
        </MuiAvatar>
      </MuiTooltip>
    );
  }, [item.addedByUser]);

  // onSelect handler — double-tap sets current climb
  const handleSelect = useCallback(() => {
    if (!isEditMode) {
      setCurrentClimbQueueItem(item);
    }
  }, [isEditMode, setCurrentClimbQueueItem, item]);

  const handleThumbnailClick = useCallback(() => {
    if (isEditMode) return;
    setCurrentClimbQueueItem(item);
    onThumbnailActivate?.();
  }, [isEditMode, setCurrentClimbQueueItem, item, onThumbnailActivate]);

  // Drag-and-drop setup
  useEffect(() => {
    if (isEditMode) return;
    const element = itemRef.current;
    if (!element) return;

    return combine(
      draggable({
        element,
        getInitialData: () => ({ index, id: item.uuid }),
      }),
      dropTargetForElements({
        element,
        getData: ({ input }) =>
          attachClosestEdge(
            { index, id: item.uuid },
            { element, input, allowedEdges: ['top', 'bottom'] },
          ),
        onDrag({ self }) {
          const edge = extractClosestEdge(self.data);
          setClosestEdge(edge);
        },
        onDragLeave() {
          setClosestEdge(null);
        },
        onDrop() {
          setClosestEdge(null);
        },
      }),
    );
  }, [index, item.uuid, isEditMode]);

  const editModeContainerStyle = useMemo(
    () => ({
      display: 'flex' as const,
      alignItems: 'center' as const,
    }),
    [],
  );

  const editModeContentStyle = useMemo(
    () => ({
      flex: 1,
      minWidth: 0,
    }),
    [],
  );

  const content = (
    <ClimbListItem
      climb={item.climb}
      boardDetails={boardDetails}
      pathname={pathname}
      isDark={isDark}
      selected={isCurrent}
      disableSwipe={isEditMode}
      disableThumbnailNavigation
      onThumbnailClick={handleThumbnailClick}
      onSelect={isEditMode ? () => onToggleSelect?.(item.uuid) : handleSelect}
      swipeRightAction={swipeRightAction}
      afterTitleSlot={afterTitleSlot}
      backgroundColor={backgroundColor}
      contentOpacity={isHistory ? 0.6 : 1}
      onOpenActions={onOpenActions}
      onOpenPlaylistSelector={onOpenPlaylistSelector}
    />
  );

  return (
    <div ref={itemRef} data-testid="queue-item" style={isEditMode ? undefined : { cursor: 'grab' }}>
      {isEditMode ? (
        <div
          style={editModeContainerStyle}
          onClick={() => onToggleSelect?.(item.uuid)}
        >
          <MuiCheckbox
            checked={isSelected}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleSelect?.(item.uuid)}
          />
          <div style={editModeContentStyle}>
            {content}
          </div>
        </div>
      ) : (
        content
      )}
      {closestEdge && <DropIndicator edge={closestEdge} gap="1px" />}
    </div>
  );
};

export default React.memo(QueueClimbListItem);
