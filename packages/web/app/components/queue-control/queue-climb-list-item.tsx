'use client';

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import MuiTooltip from '@mui/material/Tooltip';
import MuiAvatar from '@mui/material/Avatar';
import MuiBadge from '@mui/material/Badge';
import MuiCheckbox from '@mui/material/Checkbox';
import MuiIconButton from '@mui/material/IconButton';
import MuiStack from '@mui/material/Stack';
import CheckOutlined from '@mui/icons-material/CheckOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import type { BoardDetails, Climb } from '@/app/lib/types';
import { draggable, dropTargetForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { DropIndicator } from '@atlaskit/pragmatic-drag-and-drop-react-drop-indicator/box';
import { attachClosestEdge, extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/types';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import BluetoothIcon from './bluetooth-icon';
import type { ClimbQueueItem } from './types';
import ClimbListItem, { type SwipeActionOverride } from '../climb-card/climb-list-item';
import { dispatchOpenPlayDrawer } from './play-drawer-event';
import { themeTokens } from '@/app/theme/theme-config';
import { getGradeTintColor } from '@/app/lib/grade-colors';
import { TickIcon } from '../logbook/tick-icon';
import { useOptionalBoardProvider } from '../board-provider/board-provider-context';

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
  isEditMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (uuid: string) => void;
  /** When the climb is user-editable (draft or within the 24h post-publish
   *  window), the queue list surfaces an Edit affordance that routes the user
   *  back to the create form. The parent is responsible for deciding which
   *  climbs qualify; this component just renders the button when asked. */
  onEditClimb?: (climb: Climb) => void;
  isEditable?: boolean;
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
  isEditMode = false,
  isSelected = false,
  onToggleSelect,
  onEditClimb,
  isEditable = false,
}) => {
  const { t } = useTranslation('session');
  const [closestEdge, setClosestEdge] = useState<Edge | null>(null);
  const itemRef = useRef<HTMLDivElement>(null);

  // Only override swipe-left (right action) to tick instead of the default add-to-queue,
  // since these items are already in the queue. Swipe-right retains default playlist/actions.
  const swipeRightAction: SwipeActionOverride = useMemo(
    () => ({
      icon: <CheckOutlined style={{ color: 'white', fontSize: 20 }} />,
      color: 'var(--color-success)',
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
    return 'transparent';
  }, [isCurrent, isHistory, item.climb.difficulty, isDark]);

  const handleEditClick = useCallback(
    (event: React.MouseEvent) => {
      // Stop the synthetic event from bubbling up to the list item's own
      // select/double-tap handlers — otherwise tapping Edit would also mark
      // this climb as current.
      event.stopPropagation();
      onEditClimb?.(item.climb);
    },
    [onEditClimb, item.climb],
  );

  // Per-climb ascent counts for the history-row tick badge. Uses the optional
  // BoardProvider hook because queue rows render in surfaces (e.g. the list
  // view route) that aren't always wrapped in one — fall through to no badge
  // rather than throwing.
  const logbook = useOptionalBoardProvider()?.logbook ?? [];
  const { badgeCount, hasSuccessfulAscent } = useMemo(() => {
    const filtered = logbook.filter(
      (ascent) => ascent.climb_uuid === item.climb.uuid && Number(ascent.angle) === item.climb.angle,
    );
    return {
      badgeCount: filtered.length,
      hasSuccessfulAscent: filtered.some((ascent) => ascent.is_ascent),
    };
  }, [logbook, item.climb.uuid, item.climb.angle]);

  const handleTickButtonClick = useCallback(
    (event: React.MouseEvent) => {
      // Stop bubbling so the row's double-tap-to-set-current handler doesn't
      // re-broadcast a history climb when the user just wants to log a tick.
      event.stopPropagation();
      onTickClick(item.climb);
    },
    [onTickClick, item.climb],
  );

  // After-title slot: history rows get the canonical tick button (same
  // TickIcon + MuiBadge styling as `TickButton` in the queue control bar);
  // current + upcoming rows keep the "added by" avatar so attribution stays
  // visible while the climb is still in the queue.
  const afterTitleSlot = useMemo(() => {
    let trailing: React.ReactNode;
    if (isHistory) {
      trailing = (
        <MuiTooltip title={t('queueList.tickHistoryClimb', { name: item.climb.name })}>
          <MuiBadge
            badgeContent={badgeCount > 0 ? badgeCount : 0}
            max={100}
            sx={{
              '& .MuiBadge-badge': {
                backgroundColor: hasSuccessfulAscent ? 'var(--color-success)' : 'var(--color-error)',
                color: 'common.white',
              },
            }}
          >
            <MuiIconButton
              size="small"
              onClick={handleTickButtonClick}
              aria-label={t('queueList.tickHistoryClimb', { name: item.climb.name })}
              sx={{ width: 24, height: 24, opacity: themeTokens.opacity.subtle }}
            >
              <TickIcon isFlash={false} />
            </MuiIconButton>
          </MuiBadge>
        </MuiTooltip>
      );
    } else {
      const avatarStyle = { width: 24, height: 24 };
      const avatarBluetoothStyle = { width: 24, height: 24, backgroundColor: 'transparent' };
      trailing = item.addedByUser ? (
        <MuiTooltip title={item.addedByUser.username}>
          <MuiAvatar sx={avatarStyle} src={item.addedByUser.avatarUrl ?? undefined}>
            <PersonOutlined />
          </MuiAvatar>
        </MuiTooltip>
      ) : (
        <MuiTooltip title={t('queueList.addedViaBluetooth')}>
          <MuiAvatar sx={avatarBluetoothStyle}>
            <BluetoothIcon style={{ color: 'var(--neutral-400)' }} />
          </MuiAvatar>
        </MuiTooltip>
      );
    }

    if (!isEditable || !onEditClimb) {
      return trailing;
    }

    return (
      <MuiStack direction="row" spacing={0.5} alignItems="center">
        <MuiTooltip title={t('queueList.editClimb')}>
          <MuiIconButton size="small" onClick={handleEditClick} sx={{ width: 24, height: 24 }}>
            <EditOutlined sx={{ fontSize: 16 }} />
          </MuiIconButton>
        </MuiTooltip>
        {trailing}
      </MuiStack>
    );
  }, [
    isHistory,
    item.addedByUser,
    item.climb.name,
    badgeCount,
    hasSuccessfulAscent,
    handleTickButtonClick,
    isEditable,
    onEditClimb,
    handleEditClick,
    t,
  ]);

  // onSelect handler — double-tap sets current climb
  const handleSelect = useCallback(() => {
    if (!isEditMode) {
      setCurrentClimbQueueItem(item);
    }
  }, [isEditMode, setCurrentClimbQueueItem, item]);

  const handleThumbnailClick = useCallback(() => {
    if (isEditMode) return;
    setCurrentClimbQueueItem(item);
    dispatchOpenPlayDrawer();
  }, [isEditMode, setCurrentClimbQueueItem, item]);

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
          attachClosestEdge({ index, id: item.uuid }, { element, input, allowedEdges: ['top', 'bottom'] }),
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
        <div style={editModeContainerStyle} onClick={() => onToggleSelect?.(item.uuid)}>
          <MuiCheckbox
            checked={isSelected}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleSelect?.(item.uuid)}
          />
          <div style={editModeContentStyle}>{content}</div>
        </div>
      ) : (
        content
      )}
      {closestEdge && <DropIndicator edge={closestEdge} gap="1px" />}
    </div>
  );
};

export default React.memo(QueueClimbListItem);
