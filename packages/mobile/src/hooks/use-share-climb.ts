import { useCallback } from 'react';
import { Platform, Share } from 'react-native';
import { buildReadableClimbViewPath } from '@boardsesh/play-view/readable-url-utils';
import type { Climb } from '@boardsesh/shared-schema';
import { WEB_BASE_URL } from '../lib/env';

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
    const url = `${WEB_BASE_URL}${buildReadableClimbViewPath({
      boardName,
      layoutId,
      sizeId,
      setIds,
      angle,
      climbUuid: climb.uuid,
      climbName: climb.name,
    })}`;
    await Share.share(Platform.OS === 'ios' ? { message: climb.name, url } : { message: `${climb.name}\n${url}` });
  }, [climb, boardName, layoutId, sizeId, setIds, angle]);
}
