'use client';

import React from 'react';
import FavoriteBorderOutlined from '@mui/icons-material/FavoriteBorderOutlined';
import Favorite from '@mui/icons-material/Favorite';
import Tooltip from '@mui/material/Tooltip';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { track } from '@/app/lib/analytics';
import { useFavorite } from './use-favorite';
import type { BoardName } from '@/app/lib/types';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import { useTranslation } from 'react-i18next';

type FavoriteButtonProps = {
  boardName: BoardName;
  climbUuid: string;
  climbName?: string;
  angle: number;
  className?: string;
  showLabel?: boolean;
  size?: 'small' | 'default';
};

export default function FavoriteButton({
  boardName,
  climbUuid,
  climbName,
  angle,
  className,
  showLabel = false,
  size = 'default',
}: FavoriteButtonProps) {
  const { t } = useTranslation('climbs');
  const { isFavorited, isLoading, toggleFavorite, isAuthenticated } = useFavorite({
    climbUuid,
  });
  const { showMessage } = useSnackbar();
  const { openAuthModal } = useAuthModal();

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();

    if (!isAuthenticated) {
      openAuthModal({
        title: t('actions.favorite.auth.title'),
        description: climbName
          ? t('actions.favorite.auth.descriptionWithName', { climbName })
          : t('actions.favorite.auth.description'),
        onSuccess: handleAuthSuccess,
      });
      return;
    }

    try {
      const newState = await toggleFavorite();

      track('Favorite Toggle', {
        boardName,
        climbUuid,
        action: newState ? 'favorited' : 'unfavorited',
      });
    } catch (error) {
      console.error(`[FavoriteButton] Error toggling favorite for ${climbUuid}:`, error);
      showMessage(t('actions.favorite.toast.updateFailed'), 'error');
    }
  };

  const handleAuthSuccess = async () => {
    // Call API directly since session state may not have updated yet
    try {
      const response = await fetch('/api/internal/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          boardName,
          climbUuid,
          angle,
        }),
      });
      if (response.ok) {
        track('Favorite Toggle', {
          boardName,
          climbUuid,
          action: 'favorited',
        });
      } else {
        console.error(`[FavoriteButton] API error for ${climbUuid}: ${response.status}`);
        showMessage(t('actions.favorite.toast.saveFailed'), 'error');
      }
    } catch (error) {
      console.error(`[FavoriteButton] Error after auth for ${climbUuid}:`, error);
      showMessage(t('actions.favorite.toast.saveFailed'), 'error');
    }
  };

  const iconStyle: React.CSSProperties = {
    fontSize: size === 'small' ? 14 : 16,
    color: isFavorited ? 'var(--color-error)' : 'inherit',
    cursor: isLoading ? 'wait' : 'pointer',
    transition: 'color 0.2s, transform 0.2s',
  };

  const Icon = isFavorited ? Favorite : FavoriteBorderOutlined;

  const content = (
    <>
      <Icon style={iconStyle} />
      {showLabel && (
        <span style={{ marginLeft: 8 }}>
          {isFavorited ? t('actions.favorite.label.favorited') : t('actions.favorite.label.favorite')}
        </span>
      )}
    </>
  );

  return (
    <Tooltip title={isFavorited ? t('actions.favorite.tooltip.remove') : t('actions.favorite.tooltip.add')}>
      <span
        onClick={handleClick}
        className={className}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          cursor: isLoading ? 'wait' : 'pointer',
        }}
        role="button"
        aria-label={isFavorited ? t('actions.favorite.tooltip.remove') : t('actions.favorite.tooltip.add')}
      >
        {content}
      </span>
    </Tooltip>
  );
}
