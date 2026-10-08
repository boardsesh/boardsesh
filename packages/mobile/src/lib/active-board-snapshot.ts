import type { UserBoard } from '@boardsesh/shared-schema';

const sanitizedSnapshots = new WeakMap<UserBoard, UserBoard>();

/** Keep the wall usable offline without persisting its protected identity or location. */
export function sanitizeActiveBoard(board: UserBoard): UserBoard {
  const previous = sanitizedSnapshots.get(board);
  if (previous) return previous;
  const sanitized: UserBoard = {
    uuid: board.uuid,
    boardType: board.boardType,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: board.setIds,
    angle: board.angle,
    isAngleAdjustable: board.isAngleAdjustable,
    hasLeds: board.hasLeds,
    // Existing local hardware associations remain usable without a connection.
    serialNumber: board.serialNumber,
    timerName: board.timerName,
    layoutName: board.layoutName,
    sizeName: board.sizeName,
    sizeDescription: board.sizeDescription,
    setNames: board.setNames,
    slug: '',
    name: '',
    ownerId: null,
    isPublic: false,
    isUnlisted: false,
    hideLocation: true,
    isOwned: false,
    createdAt: '',
    totalAscents: 0,
    uniqueClimbers: 0,
    followerCount: 0,
    commentCount: 0,
    isFollowedByMe: false,
    canEdit: false,
  };
  sanitizedSnapshots.set(board, sanitized);
  sanitizedSnapshots.set(sanitized, sanitized);
  return sanitized;
}
