'use client';

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import PlayCircleOutlineOutlined from '@mui/icons-material/PlayCircleOutlineOutlined';
import type { ClimbActionProps, ClimbActionResult } from '../types';
import { useOptionalQueueActions, useOptionalCurrentClimb } from '../../graphql-queue';
import { buildActionResult, computeActionDisplay, ActionIconElement } from '../action-view-renderer';
import { useOptionalPlaylistActivation } from '../playlist-activation-context';

export function SetActiveAction({
  climb,
  viewMode,
  size = 'default',
  showLabel,
  disabled,
  className,
  onComplete,
}: ClimbActionProps): ClimbActionResult {
  const { t } = useTranslation('climbs');
  const queueActions = useOptionalQueueActions();
  const currentClimbData = useOptionalCurrentClimb();
  const playlistActivation = useOptionalPlaylistActivation();
  const { iconSize } = computeActionDisplay(viewMode, size, showLabel);

  const isCurrentClimb = currentClimbData?.currentClimb?.uuid === climb.uuid;

  const handleClick = useCallback(
    (e?: React.MouseEvent) => {
      e?.stopPropagation();
      e?.preventDefault();

      if ((!queueActions && !playlistActivation) || isCurrentClimb) return;

      // The PostHog "Set Active Climb" event is fired centrally from the
      // queue context's setCurrentClimb / setCurrentClimbQueueItem, so we
      // don't fire it here — that would double-count clicks. The funnel was
      // dropping to ~6% because the button used to be the only firing site.
      if (playlistActivation) {
        void playlistActivation.activatePlaylistClimb(climb);
      } else {
        void queueActions?.setCurrentClimb(climb, { playlistSuggestionSource: null });
      }

      onComplete?.();
    },
    [queueActions, playlistActivation, isCurrentClimb, climb, onComplete],
  );

  const label = isCurrentClimb ? t('actions.sendToBoard.active') : t('actions.sendToBoard.label');
  const tooltip = isCurrentClimb ? t('actions.sendToBoard.activeTooltip') : t('actions.sendToBoard.tooltip');
  const iconStyle = isCurrentClimb ? { color: 'var(--color-primary)', fontSize: iconSize } : { fontSize: iconSize };
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
    available: !!queueActions || !!playlistActivation,
    iconElementOverride: (
      <ActionIconElement tooltip={tooltip} onClick={handleClick} className={className}>
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
