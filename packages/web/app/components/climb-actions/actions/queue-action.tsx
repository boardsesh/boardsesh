'use client';

import React, { useState, useCallback } from 'react';
import AddCircleOutlined from '@mui/icons-material/AddCircleOutlined';
import CheckCircleOutlined from '@mui/icons-material/CheckCircleOutlined';
import { track } from '@/app/lib/analytics';
import type { ClimbActionProps, ClimbActionResult } from '../types';
import { useOptionalQueueActions } from '../../graphql-queue';
import { themeTokens } from '@/app/theme/theme-config';
import {
  buildActionResult,
  computeActionDisplay,
  ActionIconElement,
  ActionButtonElement,
  ActionListElement,
} from '../action-view-renderer';

export function QueueAction({
  climb,
  boardDetails,
  viewMode,
  size = 'default',
  showLabel,
  disabled,
  className,
  onComplete,
}: ClimbActionProps): ClimbActionResult {
  const queueActions = useOptionalQueueActions();
  const [recentlyAdded, setRecentlyAdded] = useState(false);
  const { iconSize, shouldShowLabel } = computeActionDisplay(viewMode, size, showLabel);

  const handleClick = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      e?.preventDefault();

      if (!queueActions?.addToQueue || recentlyAdded) return;

      queueActions.addToQueue(climb);

      track('Add to Queue', {
        source: 'climbActions',
        boardLayout: boardDetails.layout_name || '',
      });

      setRecentlyAdded(true);
      setTimeout(() => {
        setRecentlyAdded(false);
      }, 5000);

      // Don't call onComplete in list mode — keep the drawer open so the user
      // sees the "Added" confirmation. Other modes close as before.
      if (viewMode !== 'list') {
        onComplete?.();
      }
    },
    [queueActions, recentlyAdded, climb, boardDetails.layout_name, onComplete, viewMode],
  );

  const label = recentlyAdded ? 'Added' : 'Add to Queue';
  const shortLabel = recentlyAdded ? 'Added' : 'Queue';

  const Icon = recentlyAdded ? CheckCircleOutlined : AddCircleOutlined;
  const iconStyle = recentlyAdded ? { color: themeTokens.colors.success, fontSize: iconSize } : { fontSize: iconSize };
  const icon = <Icon sx={iconStyle} />;
  const ListIcon = recentlyAdded ? CheckCircleOutlined : AddCircleOutlined;
  const listIcon = <ListIcon sx={{ fontSize: iconSize }} />;

  return buildActionResult({
    key: 'queue',
    label,
    icon,
    onClick: handleClick,
    viewMode,
    size,
    showLabel,
    disabled: disabled || recentlyAdded,
    className,
    available: !!queueActions,
    iconElementOverride: (
      <ActionIconElement
        tooltip={recentlyAdded ? 'Added to queue' : 'Add to queue'}
        onClick={handleClick}
        className={className}
      >
        <span style={{ cursor: recentlyAdded ? 'not-allowed' : 'pointer' }}>{icon}</span>
      </ActionIconElement>
    ),
    buttonElementOverride: (
      <ActionButtonElement
        icon={icon}
        label={viewMode === 'compact' ? shortLabel : label}
        showLabel={shouldShowLabel}
        onClick={handleClick}
        disabled={disabled || recentlyAdded}
        size={size}
        className={className}
      />
    ),
    listElementOverride: (
      <ActionListElement icon={listIcon} label={label} onClick={handleClick} disabled={disabled || recentlyAdded} />
    ),
    menuItem: {
      key: 'queue',
      label,
      icon,
      onClick: () => handleClick(),
      disabled: recentlyAdded,
    },
  });
}

export default QueueAction;
