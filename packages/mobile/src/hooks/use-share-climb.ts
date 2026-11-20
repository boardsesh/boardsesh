import { useCallback } from 'react';
import { Share } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useToast } from '../providers/toast-provider';
import { shareLink } from '../lib/share-link';
import { buildReadableClimbViewPath } from '@boardsesh/play-view/readable-url-utils';
import type { Climb } from '@boardsesh/shared-schema';
import { CLIMB_SHARE_BASE_URL } from '../lib/env';
import { buildOgImageUrl, prewarmShareCaches } from '../lib/share-prewarm';
import { buildSprayClimbSharePath, sprayWallVisibility, type SprayWallVisibility } from '../lib/spray/spray-share';
import { getSprayWall } from '../lib/spray/spray-wall-registry';

type ShareClimbArgs = {
  climb: Climb | null;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

type ShareTarget = { path: string | null; sprayVisibility: SprayWallVisibility | null };

/**
 * Where a share points.
 *
 * A catalogue board shares its readable config-tuple URL. A spray wall has none
 * that www can render, so it shares `/b/{slug}/...`, read off the registered
 * wall at tap time — the play drawer is drawing that wall, so the registry holds
 * it. A private wall, or one the registry does not hold, has no link to give and
 * the share carries the climb name alone rather than a URL that 404s.
 */
function resolveShareTarget(
  climb: Climb,
  { boardName, layoutId, sizeId, setIds, angle }: Omit<ShareClimbArgs, 'climb'>,
): ShareTarget {
  if (boardName !== 'spray') {
    return {
      path: buildReadableClimbViewPath({
        boardName,
        layoutId,
        sizeId,
        setIds,
        angle,
        climbUuid: climb.uuid,
        climbName: climb.name,
      }),
      sprayVisibility: null,
    };
  }

  const wall = getSprayWall(layoutId);
  if (!wall?.share) return { path: null, sprayVisibility: null };
  return {
    path: buildSprayClimbSharePath({
      slug: wall.share.slug,
      // The wall's own angle when it has one: a wall does not adjust, and a
      // route param can carry a stale angle from a deep link.
      angle: wall.angle ?? angle,
      climbUuid: climb.uuid,
      climbName: climb.name,
      wallUuid: wall.wallUuid,
      isPublic: wall.share.isPublic,
      isUnlisted: wall.share.isUnlisted,
    }),
    sprayVisibility: sprayWallVisibility(wall.share),
  };
}

export function useShareClimb({ climb, boardName, layoutId, sizeId, setIds, angle }: ShareClimbArgs) {
  const { t } = useTranslation('session');
  const { showToast } = useToast();
  return useCallback(async () => {
    if (!climb) return;
    const { path, sprayVisibility } = resolveShareTarget(climb, { boardName, layoutId, sizeId, setIds, angle });

    if (!path) {
      await Share.share({ message: climb.name });
      return;
    }

    const url = `${CLIMB_SHARE_BASE_URL}${path}`;
    const fallbackOgImageUrl = buildOgImageUrl({
      boardName,
      layoutId,
      sizeId,
      setIds,
      frames: climb.frames,
      sprayVisibility,
    });
    void prewarmShareCaches(url, fallbackOgImageUrl);

    const result = await shareLink({ url, message: climb.name });
    if (result === 'copied') showToast(t('detail.shareSuccess'), 'success');
  }, [climb, boardName, layoutId, sizeId, setIds, angle, showToast, t]);
}
