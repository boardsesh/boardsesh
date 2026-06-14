'use client';

import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { ClimbActions } from './climb-actions';
import { ACTION_SHEET_ACTION_ORDER, type ClimbActionType } from './types';
import DrawerClimbHeader from '@/app/components/climb-card/drawer-climb-header';
import SwipeableDrawer from '@/app/components/swipeable-drawer/swipeable-drawer';
import drawerCss from '@/app/components/swipeable-drawer/swipeable-drawer.module.css';
import { useDrawerDragResize } from '@/app/hooks/use-drawer-drag-resize';
import { getExcludedClimbActions } from '@/app/lib/climb-action-utils';
import type { BoardDetails, Climb } from '@/app/lib/types';
import { themeTokens } from '@/app/theme/theme-config';

const DEFAULT_DRAWER_STYLES = {
  wrapper: {
    width: '100%',
    touchAction: 'pan-y' as const,
    transition: 'height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
  },
  body: { padding: `${themeTokens.spacing[2]}px 0` },
  header: {
    paddingLeft: `${themeTokens.spacing[3]}px`,
    paddingRight: `${themeTokens.spacing[3]}px`,
  },
};

type ClimbActionsDrawerProps = {
  open: boolean;
  onClose: () => void;
  climb: Climb;
  boardDetails: BoardDetails;
  /** Angle for the actions context — defaults to the climb's own angle. */
  angle?: number;
  /** Pre-computed exclude list. When omitted, derives from
   *  getExcludedClimbActions(boardDetails.board_name, 'list'). */
  exclude?: ClimbActionType[];
  /** Optional handlers forwarded into ClimbActions. */
  onOpenPlaylistSelector?: () => void;
  onTickAction?: () => void;
  onGoToQueue?: () => void;
};

/**
 * Shared bottom drawer that surfaces the standard `ClimbActions` menu
 * with a climb-header preview at the top. Used everywhere a climb has
 * an actions affordance (climb-list rows, similar-climbs cards, etc.) so
 * the drawer looks identical wherever it's invoked. Encapsulates
 * `useDrawerDragResize` so every caller gets drag-to-dismiss for free.
 */
export default function ClimbActionsDrawer({
  open,
  onClose,
  climb,
  boardDetails,
  angle,
  exclude,
  onOpenPlaylistSelector,
  onTickAction,
  onGoToQueue,
}: ClimbActionsDrawerProps) {
  const pathname = usePathname();
  const { paperRef, dragHandlers } = useDrawerDragResize({ open, onClose });

  const resolvedExclude = useMemo(
    () => exclude ?? getExcludedClimbActions(boardDetails.board_name, 'list'),
    [exclude, boardDetails.board_name],
  );

  return (
    <SwipeableDrawer
      title={
        <div data-swipe-blocked="" {...dragHandlers} className={drawerCss.dragHeaderWrapper}>
          <DrawerClimbHeader climb={climb} boardDetails={boardDetails} />
        </div>
      }
      placement="bottom"
      height="60%"
      paperRef={paperRef}
      open={open}
      onClose={onClose}
      swipeEnabled={false}
      styles={DEFAULT_DRAWER_STYLES}
    >
      <ClimbActions
        climb={climb}
        boardDetails={boardDetails}
        angle={angle ?? climb.angle}
        currentPathname={pathname}
        viewMode="list"
        include={ACTION_SHEET_ACTION_ORDER}
        exclude={resolvedExclude}
        onOpenPlaylistSelector={onOpenPlaylistSelector}
        onActionComplete={onClose}
        onTickAction={onTickAction}
        onGoToQueue={onGoToQueue}
      />
    </SwipeableDrawer>
  );
}
