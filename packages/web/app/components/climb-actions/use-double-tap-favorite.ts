'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useFavorite } from './use-favorite';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';

interface UseDoubleTapFavoriteOptions {
  climbUuid: string;
}

interface UseDoubleTapFavoriteReturn {
  handleDoubleTap: () => void;
  showHeart: boolean;
  dismissHeart: () => void;
  isFavorited: boolean;
  toggleFavorite: () => Promise<boolean>;
}

/**
 * Manages favorite toggle + heart animation state for double-tap-to-like.
 * Instagram-style: double-tap only adds a like, never removes it.
 *
 * Returns a plain `handleDoubleTap` callback. Callers wire it to their
 * own double-tap detection (e.g. pass as `onDoubleTap` to SwipeBoardCarousel,
 * or as `onCoverDoubleClick` to ClimbCard — both already call useDoubleTap
 * internally).
 */
export function useDoubleTapFavorite({ climbUuid }: UseDoubleTapFavoriteOptions): UseDoubleTapFavoriteReturn {
  const { isFavorited, toggleFavorite, isAuthenticated } = useFavorite({ climbUuid });
  const [showHeart, setShowHeart] = useState(false);
  const { openAuthModal } = useAuthModal();

  // Read isFavorited via ref at call time so handleDoubleTap stays stable.
  // useEffect ensures the ref only updates when isFavorited actually changes.
  const isFavoritedRef = useRef(isFavorited);
  useEffect(() => {
    isFavoritedRef.current = isFavorited;
  }, [isFavorited]);

  const handleDoubleTap = useCallback(() => {
    if (!isAuthenticated) {
      openAuthModal({
        title: "Sign in to like climbs",
        description: "Save your favorite climbs so you can find them later.",
      });
      return;
    }

    // Always show heart animation
    setShowHeart(true);

    // Only toggle if not already favorited (Instagram behavior)
    if (!isFavoritedRef.current) {
      void toggleFavorite().catch(() => {
        // Errors are handled by the mutation's onError handler (snackbar + rollback)
      });
    }
  }, [isAuthenticated, toggleFavorite, openAuthModal]);

  const dismissHeart = useCallback(() => {
    setShowHeart(false);
  }, []);

  return {
    handleDoubleTap,
    showHeart,
    dismissHeart,
    isFavorited,
    toggleFavorite,
  };
}
