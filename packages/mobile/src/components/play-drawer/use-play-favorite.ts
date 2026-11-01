import { useCallback } from 'react';
import type { Climb } from '@boardsesh/shared-schema';
import type { TFunction } from 'i18next';
import { hapticSelection } from '../../lib/haptics';
import type { useToast } from '../../providers/toast-provider';
import type { PlayCoreEnhancementSnapshot } from './PlayCoreEnhancements';

/** Where the toggle came from, as the FavoriteToggle event's `source`. */
type PlayFavoriteSource = 'mobile_play_drawer' | 'play_drawer_menu';

type PlayFavoriteOptions = {
  displayedClimb: Climb | null | undefined;
  boardName: string;
  layoutId: number;
  angle: number;
  bluetoothConnected: boolean;
  serverFavorited: boolean | undefined;
  // Already privacy/credential-scoped by the deferred enhancement host. This
  // hook adds no query observers or provider subscriptions to opening.
  toggleFavoriteMutate: PlayCoreEnhancementSnapshot['toggleFavoriteMutate'] | undefined;
  showToast: ReturnType<typeof useToast>['showToast'];
  t: TFunction<'session'>;
};

/**
 * The player's heart. It draws the shared `favoriteStatus` cache entry and
 * nothing else: `useToggleFavorite` flips that entry the moment a tap lands,
 * settles it on the server's answer, and puts it back on a failure, only ever
 * for the newest tap on that climb at that angle. Every heart on the climb (this
 * one, the MiniPlayer's, #6940) reads the same entry, so they can't disagree,
 * and a new climb shows its own entry with nothing left over from the last.
 */
export function usePlayFavorite({
  displayedClimb,
  boardName,
  layoutId,
  angle,
  bluetoothConnected,
  serverFavorited,
  toggleFavoriteMutate,
  showToast,
  t,
}: PlayFavoriteOptions) {
  const isFavorited = serverFavorited ?? false;
  const toggleFavorite = useCallback(
    (source: PlayFavoriteSource) => {
      if (!displayedClimb || !toggleFavoriteMutate) return;
      // No haptic here: the button that toggles it ticks a selection, and a
      // failure buzzes through its error toast. The toggle tracks the tap, in
      // the direction it really goes.
      toggleFavoriteMutate(
        {
          input: { boardName, climbUuid: displayedClimb.uuid, angle },
          currentlyFavorited: isFavorited,
          tracking: { source, layoutId, connected: bluetoothConnected },
        },
        // The toggle puts the heart back itself; this says it didn't stick.
        { onError: () => showToast(t('playView.favoriteError'), 'error') },
      );
    },
    [displayedClimb, isFavorited, boardName, layoutId, angle, bluetoothConnected, toggleFavoriteMutate, showToast, t],
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

  return { isFavorited, handleToggleFavorite, handleToggleFavoriteFromMenu };
}
