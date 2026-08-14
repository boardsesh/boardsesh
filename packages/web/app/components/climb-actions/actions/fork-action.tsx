'use client';

import React from 'react';
import MuiButton from '@mui/material/Button';
import { ActionTooltip } from '../action-tooltip';
import CallSplitOutlined from '@mui/icons-material/CallSplitOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import { track } from '@/app/lib/analytics';
import { useSession } from 'next-auth/react';
import type { ClimbActionProps, ClimbActionResult } from '../types';
import { buildAppCreateClimbUrl } from '@/app/lib/app-handoff';
import { themeTokens } from '@/app/theme/theme-config';
import { buildActionResult, computeActionDisplay } from '../action-view-renderer';

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
  const { data: session } = useSession();

  // Fork is not supported for moonboard yet
  const isMoonboard = boardDetails.board_name === 'moonboard';
  const canFork = !isMoonboard;

  const isEdit = !!climb.is_draft && !!climb.userId && climb.userId === session?.user?.id;

  const forkSeed = isEdit
    ? {
        frames: climb.frames,
        name: climb.name,
        description: climb.description ?? undefined,
        editClimbUuid: climb.uuid,
      }
    : { frames: climb.frames, name: climb.name };
  // The editor lives in the app — W-17 (#4433) deleted www's `…/create` routes.
  // The numeric board tuple goes over as-is, so a shadowed size (Kilter 12x12
  // without kickboard) still remixes onto its own board; no slug round trip and
  // no name lookup to drift.
  const url = canFork
    ? buildAppCreateClimbUrl(
        {
          boardName: boardDetails.board_name,
          layoutId: boardDetails.layout_id,
          sizeId: boardDetails.size_id,
          setIds: boardDetails.set_ids,
          angle,
        },
        forkSeed,
      )
    : null;

  const handleClick = () => {
    track(isEdit ? 'Draft Edited' : 'Climb Forked', {
      boardLayout: boardDetails.layout_name || '',
      originalClimb: climb.uuid,
    });
    onComplete?.();
  };

  const label = isEdit ? 'Edit' : 'Remix this climb';
  const tooltip = isEdit ? 'Edit this draft' : 'Remix this climb';
  const icon = isEdit ? (
    <EditOutlined sx={{ fontSize: iconSize }} />
  ) : (
    <CallSplitOutlined sx={{ fontSize: iconSize }} />
  );

  // Link-based actions need custom elements. These are plain cross-origin <a>
  // tags, not LocaleLink: the app has no /es, /fr or /de routing and Next's
  // client router doesn't own the hop.
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
      <ActionTooltip title={tooltip}>
        <a href={url} onClick={handleClick} className={className} style={linkResetStyle}>
          {icon}
        </a>
      </ActionTooltip>
    ) : null,
    buttonElementOverride: url ? (
      <a href={url} onClick={handleClick} style={linkResetStyle}>
        <MuiButton
          variant="outlined"
          startIcon={icon}
          size={size === 'large' ? 'large' : 'small'}
          disabled={disabled}
          className={className}
        >
          {shouldShowLabel && label}
        </MuiButton>
      </a>
    ) : null,
    listElementOverride: url ? (
      <a href={url} onClick={handleClick} style={linkResetStyle}>
        <MuiButton
          variant="text"
          startIcon={icon}
          fullWidth
          disabled={disabled}
          sx={{
            height: 48,
            justifyContent: 'flex-start',
            paddingLeft: `${themeTokens.spacing[4]}px`,
            fontSize: themeTokens.typography.fontSize.base,
            color: 'text.primary',
            '& .MuiButton-startIcon': {
              color: 'text.secondary',
            },
            '&:hover': {
              backgroundColor: 'action.hover',
            },
          }}
        >
          {label}
        </MuiButton>
      </a>
    ) : null,
    menuItem: url
      ? {
          key: 'fork',
          label: (
            <a href={url} onClick={handleClick} style={linkResetStyle}>
              {label}
            </a>
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
