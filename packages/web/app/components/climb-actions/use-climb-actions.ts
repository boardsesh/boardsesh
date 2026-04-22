'use client';

import { useState, useCallback, useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { track } from '@/app/lib/analytics';
import { useQueueActions } from '../graphql-queue';
import { useFavorite } from './use-favorite';
import {
  constructCreateClimbUrl,
  constructClimbInfoUrl,
  getContextAwareClimbViewUrl,
  appendReturnUrl,
} from '@/app/lib/url-utils';
import type { Climb, BoardDetails } from '@/app/lib/types';
import type { UseClimbActionsReturn } from './types';
import { openExternalUrl } from '@/app/lib/open-external-url';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import { useTranslation } from 'react-i18next';

type UseClimbActionsOptions = {
  climb: Climb;
  boardDetails: BoardDetails;
  angle: number;
  auroraAppUrl?: string;
  onActionComplete?: (action: string) => void;
};

export function useClimbActions({
  climb,
  boardDetails,
  angle,
  auroraAppUrl,
  onActionComplete,
}: UseClimbActionsOptions): UseClimbActionsReturn {
  const { t } = useTranslation('climbs');
  const router = useLocaleRouter();
  const pathname = usePathname();
  const { addToQueue, mirrorClimb } = useQueueActions();
  const { showMessage } = useSnackbar();

  const [recentlyAddedToQueue, setRecentlyAddedToQueue] = useState(false);
  const { openAuthModal } = useAuthModal();

  const {
    isFavorited,
    isLoading: isFavoriteLoading,
    toggleFavorite,
    isAuthenticated,
  } = useFavorite({
    climbUuid: climb?.uuid ?? '',
  });

  // Computed availability
  const canFork = useMemo(() => {
    return !!(boardDetails.layout_name && boardDetails.size_name && boardDetails.set_names);
  }, [boardDetails.layout_name, boardDetails.size_name, boardDetails.set_names]);

  const canMirror = useMemo(() => {
    return boardDetails.supportsMirroring === true;
  }, [boardDetails.supportsMirroring]);

  // URLs
  const viewDetailsUrl = useMemo(() => {
    if (!climb) return '';
    const base = getContextAwareClimbViewUrl(pathname, boardDetails, angle, climb.uuid, climb.name);
    return appendReturnUrl(base, pathname);
  }, [climb, pathname, boardDetails, angle]);

  const forkUrl = useMemo(() => {
    if (!climb || !canFork) return null;

    return constructCreateClimbUrl(
      boardDetails.board_name,
      boardDetails.layout_name!,
      boardDetails.size_name!,
      boardDetails.size_description,
      boardDetails.set_names!,
      angle,
      { frames: climb.frames, name: climb.name },
    );
  }, [climb, canFork, boardDetails, angle]);

  const openInAppUrl = useMemo(() => {
    if (!climb) return null;
    return auroraAppUrl || constructClimbInfoUrl(boardDetails, climb.uuid);
  }, [climb, boardDetails, auroraAppUrl]);

  // Action handlers
  const handleViewDetails = useCallback(() => {
    if (!climb) return;

    track('Climb Info Viewed', {
      boardLayout: boardDetails.layout_name || '',
      climbUuid: climb.uuid,
    });

    router.push(viewDetailsUrl);
    onActionComplete?.('viewDetails');
  }, [climb, boardDetails.layout_name, viewDetailsUrl, router, onActionComplete]);

  const handleFork = useCallback(() => {
    if (!climb || !forkUrl) return;

    track('Climb Forked', {
      boardLayout: boardDetails.layout_name || '',
      originalClimb: climb.uuid,
    });

    router.push(forkUrl);
    onActionComplete?.('fork');
  }, [climb, forkUrl, boardDetails.layout_name, router, onActionComplete]);

  const handleFavorite = useCallback(async () => {
    if (!climb) return;

    if (!isAuthenticated) {
      openAuthModal({
        title: 'Sign in to save favorites',
        description: `Sign in to save "${climb.name}" to your favorites.`,
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
      onActionComplete?.('favorite');
    } catch {
      // Silently fail
    }
  }, [climb, isAuthenticated, toggleFavorite, boardDetails.board_name, onActionComplete, openAuthModal]);

  const handleQueue = useCallback(() => {
    if (!climb || !addToQueue || recentlyAddedToQueue) return;

    addToQueue(climb);

    track('Add to Queue', {
      source: 'climbActions',
      boardLayout: boardDetails.layout_name || '',
    });

    setRecentlyAddedToQueue(true);
    setTimeout(() => {
      setRecentlyAddedToQueue(false);
    }, 5000);

    onActionComplete?.('queue');
  }, [climb, addToQueue, recentlyAddedToQueue, boardDetails.layout_name, onActionComplete]);

  const handleTick = useCallback(() => {
    // TickButton handles its own drawer/modal logic
    // This is a placeholder that components can override
    onActionComplete?.('tick');
  }, [onActionComplete]);

  const handleOpenInApp = useCallback(() => {
    if (!climb || !openInAppUrl) return;

    track('Open in Aurora App', {
      boardName: boardDetails.board_name,
      climbUuid: climb.uuid,
    });

    openExternalUrl(openInAppUrl);
    onActionComplete?.('openInApp');
  }, [climb, boardDetails.board_name, openInAppUrl, onActionComplete]);

  const handleMirror = useCallback(() => {
    if (!canMirror) return;

    mirrorClimb();

    track('Mirror Climb', {
      boardName: boardDetails.board_name,
      climbUuid: climb?.uuid,
    });

    onActionComplete?.('mirror');
  }, [canMirror, mirrorClimb, boardDetails.board_name, climb?.uuid, onActionComplete]);

  const handleShare = useCallback(async () => {
    if (!climb) return;

    const shareUrl = typeof window !== 'undefined' ? `${window.location.origin}${viewDetailsUrl}` : viewDetailsUrl;

    const shareData = {
      title: climb.name,
      text: t('share.actionText', { climbName: climb.name, difficulty: climb.difficulty }),
      url: shareUrl,
    };

    try {
      if (navigator.share && navigator.canShare?.(shareData)) {
        await navigator.share(shareData);
        track('Climb Shared', {
          boardName: boardDetails.board_name,
          climbUuid: climb.uuid,
          method: 'native',
        });
      } else {
        await navigator.clipboard.writeText(shareUrl);
        showMessage(t('share.linkCopied'), 'success');
        track('Climb Shared', {
          boardName: boardDetails.board_name,
          climbUuid: climb.uuid,
          method: 'clipboard',
        });
      }
      onActionComplete?.('share');
    } catch (error) {
      // User cancelled share or error occurred
      if ((error as Error).name !== 'AbortError') {
        // Fallback to clipboard
        try {
          await navigator.clipboard.writeText(shareUrl);
          showMessage(t('share.linkCopied'), 'success');
        } catch {
          showMessage(t('share.shareFailed'), 'error');
        }
      }
    }
  }, [climb, viewDetailsUrl, boardDetails.board_name, onActionComplete, showMessage, t]);

  return {
    // Action handlers
    handleViewDetails,
    handleFork,
    handleFavorite,
    handleQueue,
    handleTick,
    handleOpenInApp,
    handleMirror,
    handleShare,

    // State
    isFavorited,
    isFavoriteLoading,
    isAuthenticated,
    recentlyAddedToQueue,

    // Computed availability
    canFork,
    canMirror,

    // URLs
    viewDetailsUrl,
    forkUrl,
    openInAppUrl,
  };
}
