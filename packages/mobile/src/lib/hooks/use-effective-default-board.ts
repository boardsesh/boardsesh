import { useEffect, useState } from 'react';
import type { UserBoard } from '@boardsesh/shared-schema';
import { useDefaultBoard } from '../graphql/hooks';
import { getStoredBoardConfig, type StoredBoardConfig } from '../board-store';

// Returns the active board, preferring the authed-user's server-side default
// and falling back to whatever was last persisted to SecureStore. Anonymous
// users only ever hit the local path; signed-in users start from the server
// and use the local cache as a backup.
export function useEffectiveDefaultBoard() {
  const { data: serverBoard, isLoading } = useDefaultBoard();
  const [localBoard, setLocalBoard] = useState<UserBoard | null>(null);

  useEffect(() => {
    if (serverBoard) return;
    getStoredBoardConfig().then((config) => {
      if (config) setLocalBoard(mapStoredConfigToUserBoard(config));
    });
  }, [serverBoard]);

  return { data: serverBoard ?? localBoard, isLoading };
}

function mapStoredConfigToUserBoard(config: StoredBoardConfig): UserBoard {
  return {
    uuid: config.boardUuid,
    slug: '',
    ownerId: '',
    boardType: config.boardName,
    layoutId: config.layoutId,
    sizeId: config.sizeId,
    setIds: config.setIds,
    name: config.boardName,
    isPublic: true,
    isUnlisted: false,
    hideLocation: false,
    isOwned: false,
    angle: config.angle,
    isAngleAdjustable: false,
    createdAt: '',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
  };
}
