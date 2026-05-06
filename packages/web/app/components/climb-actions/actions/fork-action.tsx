'use client';

import React from 'react';
import MuiButton from '@mui/material/Button';
import { ActionTooltip } from '../action-tooltip';
import CallSplitOutlined from '@mui/icons-material/CallSplitOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import LocaleLink from '@/app/components/i18n/locale-link';
import { track } from '@/app/lib/analytics';
import { useSession } from 'next-auth/react';
import type { ClimbActionProps, ClimbActionResult } from '../types';
import { constructCreateClimbUrl } from '@/app/lib/url-utils';
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
  const canFork = !isMoonboard && !!(boardDetails.layout_name && boardDetails.size_name && boardDetails.set_names);

  const isEdit = !!climb.is_draft && !!climb.userId && climb.userId === session?.user?.id;

  const url = canFork
    ? constructCreateClimbUrl(
        boardDetails.board_name,
        boardDetails.layout_name!,
        boardDetails.size_name!,
        boardDetails.size_description,
        boardDetails.set_names!,
        angle,
        isEdit
          ? {
              frames: climb.frames,
              name: climb.name,
              description: climb.description,
              editClimbUuid: climb.uuid,
            }
          : { frames: climb.frames, name: climb.name },
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
      <ActionTooltip title={tooltip}>
        <LocaleLink href={url} prefetch={false} onClick={handleClick} className={className} style={linkResetStyle}>
          {icon}
        </LocaleLink>
      </ActionTooltip>
    ) : null,
    buttonElementOverride: url ? (
      <LocaleLink href={url} prefetch={false} onClick={handleClick} style={linkResetStyle}>
        <MuiButton
          variant="outlined"
          startIcon={icon}
          size={size === 'large' ? 'large' : 'small'}
          disabled={disabled}
          className={className}
        >
          {shouldShowLabel && label}
        </MuiButton>
      </LocaleLink>
    ) : null,
    listElementOverride: url ? (
      <LocaleLink href={url} prefetch={false} onClick={handleClick} style={linkResetStyle}>
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
      </LocaleLink>
    ) : null,
    menuItem: url
      ? {
          key: 'fork',
          label: (
            <LocaleLink href={url} prefetch={false} onClick={handleClick} style={linkResetStyle}>
              {label}
            </LocaleLink>
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
