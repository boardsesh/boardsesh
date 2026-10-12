import { useCallback, useState } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import type { TFunction } from 'i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { track } from '../../lib/analytics';
import { hapticSelection } from '../../lib/haptics';
import type { useToast } from '../../providers/toast-provider';
import type { PlayCoreEnhancementSnapshot } from './PlayCoreEnhancements';
import { resolveFavoriteRollback } from './favorite-rollback';

/** Where the toggle came from, as the FavoriteToggle event's `source`. */
type PlayFavoriteSource = 'mobile_play_drawer' | 'play_drawer_menu';

type PlayFavoriteOptions = {
  displayedClimb: Climb | null | undefined;
  boardName: string;
  layoutId: number;
  angle: number;
  serverFavorited: boolean | undefined;
  // Already privacy/credential-scoped by the deferred enhancement host. This
  // hook adds no query observers or provider subscriptions to opening.
  toggleFavoriteMutate: PlayCoreEnhancementSnapshot['toggleFavoriteMutate'] | undefined;
  showToast: ReturnType<typeof useToast>['showToast'];
  t: TFunction<'session'>;
};

export function usePlayFavorite({
  displayedClimb,
  boardName,
  layoutId,
  angle,
  serverFavorited,
  toggleFavoriteMutate,
  showToast,
  t,
}: PlayFavoriteOptions) {
  const [favoriteOverride, setFavoriteOverride] = useState<boolean | null>(null);
  const isFavorited = favoriteOverride ?? serverFavorited ?? false;
  // Core invokes this in its original climb-change effect and explicit-open
  // callback, including a fresh nonce reopening the same climb.
  const resetFavoriteOverride = useCallback(() => setFavoriteOverride(null), []);
  const toggleFavorite = useCallback(
    (source: PlayFavoriteSource) => {
      if (!displayedClimb || !toggleFavoriteMutate) return;
      // No haptic here: the button that toggles it ticks a selection, and a
      // failure buzzes through its error toast.
      const nextIsFavorited = !isFavorited;
      const previousOverride = favoriteOverride;
      setFavoriteOverride(nextIsFavorited);
      track(SHARED_EVENTS.FavoriteToggle, {
        action: nextIsFavorited ? 'added' : 'removed',
        climbUuid: displayedClimb.uuid,
        boardName,
        layoutId,
        source,
      });
      toggleFavoriteMutate(
        {
          input: {
            boardName,
            climbUuid: displayedClimb.uuid,
            angle,
          },
          currentlyFavorited: isFavorited,
        },
        {
          // Reconcile to the server's authoritative result — the backend toggles
          // off the real DB state, so this is the truth even if our optimistic
          // guess was wrong.
          onSuccess: (response) => {
            setFavoriteOverride(response.toggleFavorite.favorited);
          },
          // Roll back the optimistic flip and tell the user it didn't stick, rather
          // than leaving the heart diverged from the server. Only undo OUR flip,
          // though: if a newer tap (or a climb change, which resets the override to
          // null) has since moved the heart, this late error must not clobber the
          // current state with this tap's stale previous value.
          onError: () => {
            setFavoriteOverride((current) => resolveFavoriteRollback(current, nextIsFavorited, previousOverride));
            showToast(t('playView.favoriteError'), 'error');
          },
        },
      );
    },
    [displayedClimb, isFavorited, favoriteOverride, boardName, layoutId, angle, toggleFavoriteMutate, showToast, t],
  );

  // The action bar's heart.
  const handleToggleFavorite = useCallback(() => toggleFavorite('mobile_play_drawer'), [toggleFavorite]);

  // ⋯'s favourite row is the same toggle as the action bar's heart, so it gets
  // the same selection tick (HIG "Playing haptics"). It reports its own source,
  // so a menu tap can be told from a heart tap.
  const handleToggleFavoriteFromMenu = useCallback(() => {
    hapticSelection();
    toggleFavorite('play_drawer_menu');
  }, [toggleFavorite]);

  return { isFavorited, resetFavoriteOverride, handleToggleFavorite, handleToggleFavoriteFromMenu };
}
