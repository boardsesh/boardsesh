import { useCallback } from 'react';
import { Platform, Share } from 'react-native';
import { buildReadableClimbViewPath } from '@boardsesh/play-view/readable-url-utils';
import type { Climb } from '@boardsesh/shared-schema';
import { CLIMB_SHARE_BASE_URL } from '../lib/env';
import { buildOgImageUrl, prewarmShareCaches } from '../lib/share-prewarm';

type ShareClimbArgs = {
  climb: Climb | null;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
};

export function useShareClimb({ climb, boardName, layoutId, sizeId, setIds, angle }: ShareClimbArgs) {
  return useCallback(async () => {
    if (!climb) return;
    const url = `${CLIMB_SHARE_BASE_URL}${buildReadableClimbViewPath({
      boardName,
      layoutId,
      sizeId,
      setIds,
      angle,
      climbUuid: climb.uuid,
      climbName: climb.name,
    })}`;

    const fallbackOgImageUrl = buildOgImageUrl({ boardName, layoutId, sizeId, setIds, frames: climb.frames });
    void prewarmShareCaches(url, fallbackOgImageUrl);

    await Share.share(Platform.OS === 'ios' ? { message: climb.name, url } : { message: `${climb.name}\n${url}` });
  }, [climb, boardName, layoutId, sizeId, setIds, angle]);
}
