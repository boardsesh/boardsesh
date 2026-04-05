'use client';

import React from 'react';
import MuiButton from '@mui/material/Button';
import { ActionTooltip } from '../action-tooltip';
import CallSplitOutlined from '@mui/icons-material/CallSplitOutlined';
import Link from 'next/link';
import { track } from '@vercel/analytics';
import { ClimbActionProps, ClimbActionResult } from '../types';
import { constructCreateClimbUrl } from '@/app/lib/url-utils';
import { buildActionResult, computeActionDisplay, listElementSx } from '../action-view-renderer';

const linkResetStyle: React.CSSProperties = { color: 'inherit', textDecoration: 'none' };

export function ForkAction({
  climb,
  boardDetails,
  angle,
  viewMode,
  size = 'default',
  showLabel,
  disabled,
  className,
  onComplete,
}: ClimbActionProps): ClimbActionResult {
  const { iconSize, shouldShowLabel } = computeActionDisplay(viewMode, size, showLabel);

  // Fork is not supported for moonboard yet
  const isMoonboard = boardDetails.board_name === 'moonboard';
  const canFork = !isMoonboard && !!(boardDetails.layout_name && boardDetails.size_name && boardDetails.set_names);

  const url = canFork
    ? constructCreateClimbUrl(
        boardDetails.board_name,
        boardDetails.layout_name!,
        boardDetails.size_name!,
        boardDetails.size_description,
        boardDetails.set_names!,
        angle,
        { frames: climb.frames, name: climb.name },
      )
    : null;

  const handleClick = () => {
    track('Climb Forked', {
      boardLayout: boardDetails.layout_name || '',
      originalClimb: climb.uuid,
    });
    onComplete?.();
  };

  const label = 'Fork';
  const icon = <CallSplitOutlined sx={{ fontSize: iconSize }} />;

  // Link-based actions need custom elements since they wrap with Next.js Link
  return buildActionResult({
    key: 'fork',
    label,
    icon,
    onClick: handleClick,
    viewMode,
    size,
    showLabel,
    disabled,
    className,
    available: canFork,
    iconElementOverride: url ? (
      <ActionTooltip title="Fork this climb">
        <Link href={url} prefetch={false} onClick={handleClick} className={className} style={linkResetStyle}>
          {icon}
        </Link>
      </ActionTooltip>
    ) : null,
    buttonElementOverride: url ? (
      <Link href={url} prefetch={false} onClick={handleClick} style={linkResetStyle}>
        <MuiButton
          variant="outlined"
          startIcon={icon}
          size={size === 'large' ? 'large' : 'small'}
          disabled={disabled}
          className={className}
        >
          {shouldShowLabel && label}
        </MuiButton>
      </Link>
    ) : null,
    listElementOverride: url ? (
      <Link href={url} prefetch={false} onClick={handleClick} style={linkResetStyle}>
        <MuiButton
          variant="text"
          startIcon={icon}
          fullWidth
          disabled={disabled}
          sx={listElementSx}
        >
          {label}
        </MuiButton>
      </Link>
    ) : null,
    menuItem: url
      ? {
          key: 'fork',
          label: (
            <Link href={url} prefetch={false} onClick={handleClick} style={linkResetStyle}>
              {label}
            </Link>
          ),
          icon,
        }
      : {
          key: 'fork',
          label,
          icon,
          disabled: true,
        },
  });
}

export default ForkAction;
