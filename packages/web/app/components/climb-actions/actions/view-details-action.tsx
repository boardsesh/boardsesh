'use client';

import React from 'react';
import MuiButton from '@mui/material/Button';
import { ActionTooltip } from '../action-tooltip';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import Link from 'next/link';
import { track } from '@/app/lib/analytics';
import type { ClimbActionProps, ClimbActionResult } from '../types';
import { getContextAwareClimbViewUrl } from '@/app/lib/url-utils';
import { themeTokens } from '@/app/theme/theme-config';
import { buildActionResult, computeActionDisplay } from '../action-view-renderer';

const linkResetStyle: React.CSSProperties = { color: 'inherit', textDecoration: 'none' };

export function ViewDetailsAction({
  climb,
  boardDetails,
  angle,
  currentPathname,
  viewMode,
  size = 'default',
  showLabel,
  disabled,
  className,
  onComplete,
}: ClimbActionProps): ClimbActionResult {
  const { iconSize, shouldShowLabel } = computeActionDisplay(viewMode, size, showLabel);

  const url = getContextAwareClimbViewUrl(currentPathname ?? '', boardDetails, angle, climb.uuid, climb.name);

  const handleClick = () => {
    track('Climb Info Viewed', {
      boardLayout: boardDetails.layout_name || '',
      climbUuid: climb.uuid,
    });
    onComplete?.();
  };

  const label = 'View Details';
  const icon = <InfoOutlined sx={{ fontSize: iconSize }} />;

  // Link-based actions need custom elements since they wrap with Next.js Link
  return buildActionResult({
    key: 'viewDetails',
    label,
    icon,
    onClick: handleClick,
    viewMode,
    size,
    showLabel,
    disabled,
    className,
    iconElementOverride: (
      <ActionTooltip title={label}>
        <Link href={url} prefetch={false} onClick={handleClick} className={className} style={linkResetStyle}>
          {icon}
        </Link>
      </ActionTooltip>
    ),
    buttonElementOverride: (
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
    ),
    listElementOverride: (
      <Link href={url} prefetch={false} onClick={handleClick} style={linkResetStyle}>
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
      </Link>
    ),
    menuItem: {
      key: 'viewDetails',
      label: (
        <Link href={url} prefetch={false} onClick={handleClick} style={linkResetStyle}>
          {label}
        </Link>
      ),
      icon,
    },
  });
}

export default ViewDetailsAction;
