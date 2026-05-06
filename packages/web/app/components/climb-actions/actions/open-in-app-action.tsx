'use client';

import React, { useCallback } from 'react';
import AppsOutlined from '@mui/icons-material/AppsOutlined';
import { track } from '@/app/lib/analytics';
import type { ClimbActionProps, ClimbActionResult } from '../types';
import { constructClimbInfoUrl } from '@/app/lib/url-utils';
import { buildActionResult, buildUnavailableResult, computeActionDisplay } from '../action-view-renderer';
import { openExternalUrl } from '@/app/lib/open-external-url';

type OpenInAppActionProps = {
  auroraAppUrl?: string;
} & ClimbActionProps;

export function OpenInAppAction({
  climb,
  boardDetails,
  viewMode,
  size = 'default',
  showLabel,
  disabled,
  className,
  onComplete,
  auroraAppUrl,
}: OpenInAppActionProps): ClimbActionResult {
  const url = auroraAppUrl || constructClimbInfoUrl(boardDetails, climb.uuid);

  const handleClick = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();

      if (!url) return;

      track('Open in Aurora App', {
        boardName: boardDetails.board_name,
        climbUuid: climb.uuid,
      });

      openExternalUrl(url);
      onComplete?.();
    },
    [boardDetails.board_name, climb.uuid, url, onComplete],
  );

  // Open in App is not available for Kilter (kilterboardapp.com is no longer accessible)
  if (!url) {
    return buildUnavailableResult('openInApp');
  }
  const { iconSize } = computeActionDisplay(viewMode, size, showLabel);

  const icon = <AppsOutlined sx={{ fontSize: iconSize }} />;

  return buildActionResult({
    key: 'openInApp',
    label: 'Open in App',
    icon,
    onClick: handleClick,
    viewMode,
    size,
    showLabel,
    disabled,
    className,
  });
}

export default OpenInAppAction;
