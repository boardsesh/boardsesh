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
import { themeTokens } from '@/app/theme/theme-config';

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
        title: 'Sign in to save favorites',
        description: climbName
          ? `Sign in to save "${climbName}" to your favorites.`
          : 'Sign in to save climbs to your favorites.',
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
      showMessage('Failed to update favorite. Please try again.', 'error');
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
        showMessage('Failed to save favorite. Please try again.', 'error');
      }
    } catch (error) {
      console.error(`[FavoriteButton] Error after auth for ${climbUuid}:`, error);
      showMessage('Failed to save favorite. Please try again.', 'error');
    }
  };

  const iconStyle: React.CSSProperties = {
    fontSize: size === 'small' ? 14 : 16,
    color: isFavorited ? themeTokens.colors.error : 'inherit',
    cursor: isLoading ? 'wait' : 'pointer',
    transition: 'color 0.2s, transform 0.2s',
  };

  const Icon = isFavorited ? Favorite : FavoriteBorderOutlined;

  const content = (
    <>
      <Icon style={iconStyle} />
      {showLabel && <span style={{ marginLeft: 8 }}>{isFavorited ? 'Favorited' : 'Favorite'}</span>}
    </>
  );

  return (
    <Tooltip title={isFavorited ? 'Remove from favorites' : 'Add to favorites'}>
      <span
        onClick={handleClick}
        className={className}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          cursor: isLoading ? 'wait' : 'pointer',
        }}
        role="button"
        aria-label={isFavorited ? 'Remove from favorites' : 'Add to favorites'}
      >
        {content}
      </span>
    </Tooltip>
  );
}
