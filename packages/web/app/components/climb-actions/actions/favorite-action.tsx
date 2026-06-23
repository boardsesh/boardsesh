'use client';

import React, { useCallback } from 'react';
import FavoriteBorderOutlined from '@mui/icons-material/FavoriteBorderOutlined';
import Favorite from '@mui/icons-material/Favorite';
import { track } from '@/app/lib/analytics';
import { useTranslation } from 'react-i18next';
import type { ClimbActionProps, ClimbActionResult } from '../types';
import { useFavorite } from '../use-favorite';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import { buildActionResult, computeActionDisplay, ActionListElement } from '../action-view-renderer';

export function FavoriteAction({
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
  const { openAuthModal } = useAuthModal();
  const { iconSize } = computeActionDisplay(viewMode, size, showLabel);

  const { isFavorited, isLoading, toggleFavorite, isAuthenticated } = useFavorite({
    climbUuid: climb.uuid,
  });

  const handleAuthSuccess = useCallback(async () => {
    try {
      const response = await fetch('/api/internal/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boardName: boardDetails.board_name,
          climbUuid: climb.uuid,
          angle,
        }),
      });
      if (response.ok) {
        track('Favorite Toggle', {
          boardName: boardDetails.board_name,
          climbUuid: climb.uuid,
          action: 'favorited',
        });
      }
    } catch {
      // Silently fail
    }
  }, [boardDetails.board_name, climb.uuid, angle]);

  const handleClick = useCallback(
    async (e?: React.MouseEvent) => {
      e?.stopPropagation();
      e?.preventDefault();

      if (!isAuthenticated) {
        openAuthModal({
          title: t('actions.favorite.auth.title'),
          description: t('actions.favorite.auth.descriptionWithName', { climbName: climb.name }),
          onSuccess: handleAuthSuccess,
        });
        return;
      }

      try {
        const newState = await toggleFavorite();
        track('Favorite Toggle', {
          boardName: boardDetails.board_name,
          climbUuid: climb.uuid,
          action: newState ? 'favorited' : 'unfavorited',
        });
        onComplete?.();
      } catch {
        // Silently fail
      }
    },
    [
      isAuthenticated,
      toggleFavorite,
      boardDetails.board_name,
      climb.uuid,
      climb.name,
      onComplete,
      openAuthModal,
      handleAuthSuccess,
      t,
    ],
  );

  const label = isFavorited ? t('actions.favorite.label.favorited') : t('actions.favorite.label.favorite');
  const HeartIcon = isFavorited ? Favorite : FavoriteBorderOutlined;
  const iconStyle = isFavorited ? { color: 'var(--color-error)', fontSize: iconSize } : { fontSize: iconSize };
  const listIcon = <HeartIcon sx={{ fontSize: iconSize }} />;

  return buildActionResult({
    key: 'favorite',
    label,
    icon: <HeartIcon sx={iconStyle} />,
    onClick: handleClick,
    viewMode,
    size,
    showLabel,
    disabled: disabled || isLoading,
    className,
    listElementOverride: (
      <ActionListElement icon={listIcon} label={label} onClick={handleClick} disabled={disabled || isLoading} />
    ),
  });
}

export default FavoriteAction;
