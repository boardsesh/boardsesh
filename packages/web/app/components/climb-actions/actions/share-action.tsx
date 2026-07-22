'use client';

import React, { useCallback } from 'react';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import IosShare from '@mui/icons-material/IosShare';
import type { ClimbActionProps, ClimbActionResult } from '../types';
import { getContextAwareClimbViewUrl } from '@/app/lib/url-utils';
import { buildActionResult, computeActionDisplay } from '../action-view-renderer';
import { shareWithFallback } from '@/app/lib/share-utils';
import { useTranslation } from 'react-i18next';

export function ShareAction({
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
  const { t } = useTranslation('climbs');
  const { showMessage } = useSnackbar();
  const { iconSize } = computeActionDisplay(viewMode, size, showLabel);

  const viewUrl = getContextAwareClimbViewUrl(currentPathname ?? '', boardDetails, angle, climb.uuid, climb.name);

  const handleClick = useCallback(
    async (e?: React.MouseEvent) => {
      e?.stopPropagation();
      e?.preventDefault();

      const shareUrl = typeof window !== 'undefined' ? `${window.location.origin}${viewUrl}` : viewUrl;

      const shared = await shareWithFallback({
        url: shareUrl,
        title: climb.name,
        text: t('share.actionText', { climbName: climb.name, difficulty: climb.difficulty }),
        trackingEvent: 'Climb Shared',
        trackingProps: { boardName: boardDetails.board_name, climbUuid: climb.uuid, source: 'climb_actions' },
        onClipboardSuccess: () => showMessage(t('share.linkCopied'), 'success'),
        onError: () => showMessage(t('share.shareFailed'), 'error'),
      });
      if (shared) {
        onComplete?.();
      }
    },
    [climb, viewUrl, boardDetails.board_name, onComplete, showMessage, t],
  );

  const icon = <IosShare sx={{ fontSize: iconSize }} />;

  return buildActionResult({
    key: 'share',
    label: t('share.actionLabel'),
    icon,
    onClick: handleClick,
    viewMode,
    size,
    showLabel,
    disabled,
    className,
  });
}

export default ShareAction;
