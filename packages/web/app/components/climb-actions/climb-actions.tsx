'use client';

import React, { useMemo, useState, useCallback } from 'react';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import MoreVertOutlined from '@mui/icons-material/MoreVertOutlined';
import {
  type ClimbActionsProps,
  type ClimbActionType,
  type ClimbActionResult,
  type ClimbActionProps,
  DEFAULT_ACTION_ORDER,
} from './types';
import {
  ViewDetailsAction,
  ForkAction,
  FavoriteAction,
  SetActiveAction,
  QueueAction,
  GoToQueueAction,
  TickAction,
  OpenInAppAction,
  MirrorAction,
  ShareAction,
  AddBetaVideoAction,
  PlaylistAction,
} from './actions';

// Extended props for OpenInAppAction
type OpenInAppActionProps = {
  auroraAppUrl?: string;
} & ClimbActionProps;

// Local type for menu items used in dropdown mode
type ActionMenuItemType = {
  key: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
};

// Map action types to their handler functions
const ACTION_FUNCTIONS: Record<ClimbActionType, (props: ClimbActionProps | OpenInAppActionProps) => ClimbActionResult> =
  {
    viewDetails: ViewDetailsAction,
    fork: ForkAction,
    favorite: FavoriteAction,
    setActive: SetActiveAction,
    queue: QueueAction,
    goToQueue: GoToQueueAction,
    tick: TickAction,
    openInApp: OpenInAppAction,
    mirror: MirrorAction,
    share: ShareAction,
    addBetaVideo: AddBetaVideoAction,
    playlist: PlaylistAction,
  };

/**
 * Helper function to create a renderer component for an action type.
 * This ensures hooks are called at the component level (valid), not inside useMemo (invalid).
 */
function createActionRenderer(
  actionFn: (props: ClimbActionProps | OpenInAppActionProps) => ClimbActionResult,
): React.FC<ClimbActionProps | OpenInAppActionProps> {
  return function ActionRenderer(props) {
    // Call the action function at component level - hooks inside are now valid
    const result = actionFn(props);
    if (!result.available) return null;
    return <React.Fragment key={result.key}>{result.element}</React.Fragment>;
  };
}

// Create stable renderer components for each action type
// These are created once at module level, so component identity is stable
const ACTION_RENDERERS: Record<ClimbActionType, React.FC<ClimbActionProps | OpenInAppActionProps>> = {
  viewDetails: createActionRenderer(ViewDetailsAction),
  fork: createActionRenderer(ForkAction),
  favorite: createActionRenderer(FavoriteAction),
  setActive: createActionRenderer(SetActiveAction),
  queue: createActionRenderer(QueueAction),
  goToQueue: createActionRenderer(GoToQueueAction),
  tick: createActionRenderer(TickAction),
  openInApp: createActionRenderer(OpenInAppAction),
  mirror: createActionRenderer(MirrorAction),
  share: createActionRenderer(ShareAction),
  addBetaVideo: createActionRenderer(AddBetaVideoAction),
  playlist: createActionRenderer(PlaylistAction),
};

export function ClimbActions({
  climb,
  boardDetails,
  angle,
  currentPathname,
  viewMode,
  include,
  exclude = [],
  size = 'default',
  className,
  onActionComplete,
  onOpenPlaylistSelector,
  auroraAppUrl,
  onTickAction,
  onGoToQueue,
}: ClimbActionsProps) {
  // Determine which actions to show
  const actionsToShow = useMemo(() => {
    let actions = include || DEFAULT_ACTION_ORDER;
    // Filter out excluded actions
    actions = actions.filter((action) => !exclude.includes(action));
    return actions;
  }, [include, exclude]);

  // Common props for all action components (memoized for stability)
  const commonProps = useMemo(
    () => ({
      climb,
      boardDetails,
      angle,
      currentPathname,
      viewMode,
      size,
      onOpenPlaylistSelector,
      auroraAppUrl,
      onTickAction,
      onGoToQueue,
    }),
    [
      climb,
      boardDetails,
      angle,
      currentPathname,
      viewMode,
      size,
      onOpenPlaylistSelector,
      auroraAppUrl,
      onTickAction,
      onGoToQueue,
    ],
  );

  // Memoize action complete handler to prevent creating new functions on every render
  const handleActionComplete = useCallback(
    (actionType: ClimbActionType) => {
      onActionComplete?.(actionType);
    },
    [onActionComplete],
  );

  // Icon mode - render each action as a component
  if (viewMode === 'icon') {
    return (
      <>
        {actionsToShow.map((actionType) => {
          const Renderer = ACTION_RENDERERS[actionType];
          if (!Renderer) return null;
          return (
            <Renderer
              key={actionType}
              {...commonProps}
              onComplete={onActionComplete ? () => handleActionComplete(actionType) : undefined}
            />
          );
        })}
      </>
    );
  }

  // Button mode - render each action as a component inside Space
  if (viewMode === 'button' || viewMode === 'compact') {
    return (
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }} className={className}>
        {actionsToShow.map((actionType) => {
          const Renderer = ACTION_RENDERERS[actionType];
          if (!Renderer) return null;
          return (
            <Renderer
              key={actionType}
              {...commonProps}
              onComplete={onActionComplete ? () => handleActionComplete(actionType) : undefined}
            />
          );
        })}
      </Stack>
    );
  }

  // List mode - render each action as a full-width row (for drawer menus)
  if (viewMode === 'list') {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', py: 1 }} className={className}>
        {actionsToShow.map((actionType) => {
          const Renderer = ACTION_RENDERERS[actionType];
          if (!Renderer) return null;
          return (
            <Renderer
              key={actionType}
              {...commonProps}
              onComplete={onActionComplete ? () => handleActionComplete(actionType) : undefined}
            />
          );
        })}
      </Box>
    );
  }

  // Dropdown mode - use DropdownActions component for proper hooks handling
  if (viewMode === 'dropdown') {
    return (
      <DropdownActions
        actionsToShow={actionsToShow}
        commonProps={commonProps}
        className={className}
        onActionComplete={onActionComplete}
      />
    );
  }

  return null;
}

/**
 * Separate component for dropdown mode to properly handle hooks.
 * Each action is rendered as its own component to ensure hooks are called correctly.
 */
function DropdownActions({
  actionsToShow,
  commonProps,
  className,
  onActionComplete,
}: {
  actionsToShow: ClimbActionType[];
  commonProps: Omit<ClimbActionProps, 'onComplete'>;
  className?: string;
  onActionComplete?: (actionType: ClimbActionType) => void;
}) {
  // Collect menu items from all actions
  const [menuItems, setMenuItems] = React.useState<ActionMenuItemType[]>([]);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const handleOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  // Create a stable callback for collecting menu items
  const menuItemsRef = React.useRef<Map<string, ClimbActionResult['menuItem']>>(new Map());

  const handleMenuItem = React.useCallback(
    (actionType: ClimbActionType, item: ClimbActionResult['menuItem']) => {
      menuItemsRef.current.set(actionType, item);
      // Update menu items state (collect all items in order)
      const items = actionsToShow
        .map((type) => {
          const menuItem = menuItemsRef.current.get(type);
          if (!menuItem) return undefined;
          return {
            key: menuItem.key as string,
            label: menuItem.label,
            icon: menuItem.icon,
            onClick: menuItem.onClick,
            danger: menuItem.danger,
          } as ActionMenuItemType;
        })
        .filter((item): item is ActionMenuItemType => item !== undefined);
      setMenuItems(items);
    },
    [actionsToShow],
  );

  return (
    <>
      <IconButton className={className} onClick={handleOpen}>
        <MoreVertOutlined />
      </IconButton>
      <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={handleClose}>
        {menuItems.map((item) => (
          <MenuItem
            key={item.key}
            onClick={() => {
              item.onClick?.();
              handleClose();
            }}
            sx={item.danger ? { color: 'error.main' } : undefined}
          >
            {item.icon && <ListItemIcon>{item.icon}</ListItemIcon>}
            <ListItemText>{item.label}</ListItemText>
          </MenuItem>
        ))}
      </Menu>
      {/* Render action components to get menu items and render any needed DOM elements */}
      {actionsToShow.map((actionType) => (
        <DropdownActionRenderer
          key={actionType}
          actionType={actionType}
          commonProps={commonProps}
          onActionComplete={onActionComplete}
          onMenuItem={(item) => handleMenuItem(actionType, item)}
        />
      ))}
    </>
  );
}

/**
 * Individual action renderer for dropdown mode.
 * This component calls the action function at component level, making hooks valid.
 */
function DropdownActionRenderer({
  actionType,
  commonProps,
  onActionComplete,
  onMenuItem,
}: {
  actionType: ClimbActionType;
  commonProps: Omit<ClimbActionProps, 'onComplete'>;
  onActionComplete?: (actionType: ClimbActionType) => void;
  onMenuItem: (item: ClimbActionResult['menuItem']) => void;
}) {
  const actionFn = ACTION_FUNCTIONS[actionType];
  // Track if we've reported the menu item to prevent infinite loops
  const hasReportedRef = React.useRef(false);
  const onMenuItemRef = React.useRef(onMenuItem);
  onMenuItemRef.current = onMenuItem;

  // Memoize action complete handler for this specific action type
  const handleActionCompleteForType = React.useCallback(() => {
    onActionComplete?.(actionType);
  }, [onActionComplete, actionType]);

  // Call action function at component level - hooks are valid here
  // Note: actionFn must be called unconditionally to maintain hooks order
  const result = actionFn({
    ...commonProps,
    viewMode: 'dropdown',
    onComplete: onActionComplete ? handleActionCompleteForType : undefined,
  });

  // Report menu item to parent only once on mount
  React.useEffect(() => {
    if (result.available && !hasReportedRef.current) {
      hasReportedRef.current = true;
      onMenuItemRef.current(result.menuItem);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Only depend on availability, not menuItem object
  }, [result.available]);

  // Render any elements needed in DOM (modals, drawers, etc.)
  if (!result.available || !result.element) return null;
  return result.element;
}

export default ClimbActions;
