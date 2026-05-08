'use client';

import React, { useCallback } from 'react';
import PlaylistAddCheckOutlined from '@mui/icons-material/PlaylistAddCheckOutlined';
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

  const myUserId = queueData?.clientId ?? null;
  const isMyPick = !!myUserId && queueData?.picks[myUserId]?.item.climb.uuid === climb.uuid;

  const handleClick = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      e?.preventDefault();

      if (!queueActions || isMyPick) return;

      void queueActions.setMyPick(climb);

      track('Set Pick Climb', {
        boardLayout: boardDetails.layout_name || '',
        climbUuid: climb.uuid,
      });

      onComplete?.();
    },
    [queueActions, isMyPick, climb, boardDetails.layout_name, onComplete],
  );

  const label = isMyPick ? 'Picked' : 'Pick this climb';
  const iconStyle = isMyPick ? { color: themeTokens.colors.primary, fontSize: iconSize } : { fontSize: iconSize };
  const icon = <PlaylistAddCheckOutlined sx={iconStyle} />;

  return buildActionResult({
    key: 'setActive',
    label,
    icon,
    onClick: handleClick,
    viewMode,
    size,
    showLabel,
    disabled: disabled || isMyPick,
    className,
    available: !!queueActions,
    iconElementOverride: (
      <ActionIconElement
        tooltip={isMyPick ? 'Your current pick' : 'Pick this climb'}
        onClick={handleClick}
        className={className}
      >
        <span style={{ cursor: isMyPick ? 'default' : 'pointer' }}>{icon}</span>
      </ActionIconElement>
    ),
    menuItem: {
      key: 'setActive',
      label,
      icon,
      onClick: () => handleClick(),
      disabled: isMyPick,
    },
  });
}

export default SetActiveAction;
