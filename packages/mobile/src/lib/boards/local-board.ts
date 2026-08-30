import type { CreateBoardInput, UserBoard } from '@boardsesh/shared-schema';
import { isOfflineBoardCard } from './offline-board-card';

export const LOCAL_BOARD_ORIGIN = 'local' as const;

/**
 * A board owned by this installation rather than the Boardsesh API.
 *
 * It deliberately remains structurally compatible with UserBoard while the
 * active-board/renderer stack is migrated to a discriminated union. `origin`
 * is the load-bearing discriminator: consumers must never infer local identity
 * from a UUID or slug prefix.
 */
export type LocalBoard = UserBoard & { origin: typeof LOCAL_BOARD_ORIGIN };

export type LocalBoardIdentity = {
  uuid: string;
  ownerId: string;
  createdAt: string;
};

/** Build the server-shaped projection needed by today's board renderer. */
export function createLocalBoard(input: CreateBoardInput, identity: LocalBoardIdentity): LocalBoard {
  return {
    origin: LOCAL_BOARD_ORIGIN,
    uuid: identity.uuid,
    slug: `local-${identity.uuid}`,
    ownerId: identity.ownerId,
    boardType: input.boardType,
    layoutId: input.layoutId,
    sizeId: input.sizeId,
    setIds: input.setIds,
    name: input.name,
    description: null,
    locationName: null,
    latitude: null,
    longitude: null,
    isPublic: false,
    isUnlisted: true,
    hideLocation: true,
    isOwned: true,
    angle: input.angle ?? 0,
    isAngleAdjustable: input.isAngleAdjustable ?? true,
    createdAt: identity.createdAt,
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    gymId: null,
    boardId: null,
    gymUuid: null,
    gymName: null,
    distanceMeters: null,
    serialNumber: null,
    timerName: null,
    canEdit: true,
  };
}

export function isLocalBoard(value: unknown): value is LocalBoard {
  if (!isOfflineBoardCard(value)) return false;
  const candidate = value as Partial<LocalBoard>;
  return (
    candidate.origin === LOCAL_BOARD_ORIGIN &&
    typeof candidate.ownerId === 'string' &&
    candidate.ownerId.length > 0 &&
    typeof candidate.createdAt === 'string' &&
    candidate.createdAt.length > 0
  );
}
