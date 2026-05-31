import { useState, useCallback, useRef, useEffect } from 'react';
import { useToggleFavorite } from '../lib/graphql/hooks';

type UseDoubleTapFavoriteParams = {
  climbUuid: string;
  boardName: string;
  angle: number;
  initialFavorited?: boolean;
};

export function useDoubleTapFavorite({
  climbUuid,
  boardName,
  angle,
  initialFavorited = false,
}: UseDoubleTapFavoriteParams) {
  const [isFavorited, setIsFavorited] = useState(initialFavorited);
  const [showHeart, setShowHeart] = useState(false);
  const isFavoritedRef = useRef(initialFavorited);
  isFavoritedRef.current = isFavorited;

  // Re-sync local state when the climb changes (FlashList recycles rows)
  // or when the server-provided initial value changes.
  useEffect(() => {
    setIsFavorited(initialFavorited);
    setShowHeart(false);
  }, [climbUuid, initialFavorited]);

  const { mutate: toggleFavorite } = useToggleFavorite();

  const handleDoubleTap = useCallback(() => {
    if (!isFavoritedRef.current) {
      setIsFavorited(true);
      // Double-tap only ever adds (it's gated on not-yet-favorited), so the
      // pre-toggle state is always false → the dual-write takes the add path.
      toggleFavorite({ input: { boardName, climbUuid, angle }, currentlyFavorited: false });
    }
    setShowHeart(true);
  }, [toggleFavorite, boardName, climbUuid, angle]);

  const dismissHeart = useCallback(() => {
    setShowHeart(false);
  }, []);

  return { handleDoubleTap, showHeart, dismissHeart, isFavorited };
}
