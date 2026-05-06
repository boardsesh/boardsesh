'use client';

import React, { useCallback } from 'react';
import PlayCircleOutlineOutlined from '@mui/icons-material/PlayCircleOutlineOutlined';
import { track } from '@/app/lib/analytics';
import type { ClimbActionProps, ClimbActionResult } from '../types';
import { useOptionalQueueActions, useOptionalQueueData } from '../../graphql-queue';
import { themeTokens } from '@/app/theme/theme-config';
import { buildActionResult, computeActionDisplay, ActionIconElement } from '../action-view-renderer';

export function SetActiveAction({
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
  const queueData = useOptionalQueueData();
  const { iconSize } = computeActionDisplay(viewMode, size, showLabel);

  const isCurrentClimb = queueData?.currentClimb?.uuid === climb.uuid;

  const handleClick = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      e?.preventDefault();

      if (!queueActions || isCurrentClimb) return;

      void queueActions.setCurrentClimb(climb);

      track('Set Active Climb', {
        boardLayout: boardDetails.layout_name || '',
        climbUuid: climb.uuid,
      });

      onComplete?.();
    },
    [queueActions, isCurrentClimb, climb, boardDetails.layout_name, onComplete],
  );

  const label = isCurrentClimb ? 'Active' : 'Set Active';
  const iconStyle = isCurrentClimb ? { color: themeTokens.colors.primary, fontSize: iconSize } : { fontSize: iconSize };
  const icon = <PlayCircleOutlineOutlined sx={iconStyle} />;

  return buildActionResult({
    key: 'setActive',
    label,
    icon,
    onClick: handleClick,
    viewMode,
    size,
    showLabel,
    disabled: disabled || isCurrentClimb,
    className,
    available: !!queueActions,
    iconElementOverride: (
      <ActionIconElement
        tooltip={isCurrentClimb ? 'Currently active' : 'Set as active climb'}
        onClick={handleClick}
        className={className}
      >
        <span style={{ cursor: isCurrentClimb ? 'default' : 'pointer' }}>{icon}</span>
      </ActionIconElement>
    ),
    menuItem: {
      key: 'setActive',
      label,
      icon,
      onClick: () => handleClick(),
      disabled: isCurrentClimb,
    },
  });
}

export default SetActiveAction;
