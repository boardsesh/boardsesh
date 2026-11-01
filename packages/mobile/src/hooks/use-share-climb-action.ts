import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import type { Climb } from '@boardsesh/shared-schema';
import { track } from '../lib/analytics';
import { useToast } from '../providers/toast-provider';
import { useShareClimb } from './use-share-climb';

/** Where the share was asked for, as the ClimbShared event's `source`. */
export type ShareClimbSource = 'play_drawer' | 'mini_player';

type ShareClimbActionArgs = {
  climb: Climb | null;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  source: ShareClimbSource;
};

/**
 * The share button's tap: the system share sheet for this climb, tracked as an
 * intent (like the actions menu), not a completion. The player's button and the
 * MiniPlayer's both use it. A failure says so in a toast: Android can throw on
 * a cancelled share, and a rejection nobody hears is worse than a toast.
 *
 * A draft has no link that opens for anyone else (#5960), so the callers leave
 * the button out for one.
 */
export function useShareClimbAction({
  climb,
  boardName,
  layoutId,
  sizeId,
  setIds,
  angle,
  source,
}: ShareClimbActionArgs): () => void {
  const { t } = useTranslation('session');
  const { showToast } = useToast();
  const shareClimb = useShareClimb({ climb, boardName, layoutId, sizeId, setIds, angle });
  return useCallback(() => {
    if (!climb) return;
    track(SHARED_EVENTS.ClimbShared, {
      method: 'share',
      source,
      climbUuid: climb.uuid,
      boardName,
      layoutId,
    });
    shareClimb().catch((error) => {
      console.warn(`[${source}] share failed:`, error);
      showToast(t('playView.shareError'), 'error');
    });
  }, [climb, source, boardName, layoutId, shareClimb, showToast, t]);
}
