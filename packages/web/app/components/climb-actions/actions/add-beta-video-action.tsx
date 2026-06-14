'use client';

import React, { useCallback, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import VideocamOutlined from '@mui/icons-material/VideocamOutlined';
import AddBetaVideoDialog from '@/app/components/beta-videos/add-beta-video-dialog';
import { track } from '@/app/lib/analytics';
import type { ClimbActionProps, ClimbActionResult } from '../types';
import { buildActionResult, computeActionDisplay } from '../action-view-renderer';

export function AddBetaVideoAction({
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
  const { t } = useTranslation('climbs');
  const { status } = useSession();
  const { iconSize } = computeActionDisplay(viewMode, size, showLabel);
  const [dialogOpen, setDialogOpen] = useState(false);
  const available = status === 'authenticated';

  const handleClick = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      e?.preventDefault();
      track('Add Beta Video Opened', {
        source: 'climb-actions',
        boardName: boardDetails.board_name,
        climbUuid: climb.uuid,
      });
      setDialogOpen(true);
    },
    [boardDetails.board_name, climb.uuid],
  );

  const handleClose = useCallback(() => {
    setDialogOpen(false);
    onComplete?.();
  }, [onComplete]);

  const label = t('actions.addBetaVideo.label');
  const icon = <VideocamOutlined sx={{ fontSize: iconSize }} />;
  const extraContent = (
    <AddBetaVideoDialog
      open={dialogOpen}
      onClose={handleClose}
      boardType={boardDetails.board_name}
      climbUuid={climb.uuid}
      climbName={climb.name}
      angle={angle}
      grade={climb.difficulty}
      setter={climb.setter_username}
      layoutId={climb.layoutId}
      surface="climb-actions"
    />
  );

  return buildActionResult({
    key: 'addBetaVideo',
    label,
    icon,
    onClick: handleClick,
    viewMode,
    size,
    showLabel,
    disabled,
    className,
    available,
    extraContent,
  });
}

export default AddBetaVideoAction;
