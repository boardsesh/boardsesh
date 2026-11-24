import { createHash } from 'node:crypto';
import type * as tables from '@boardsesh/db/schema';

type BoardRow = typeof tables.userBoards.$inferSelect;
type BoardPolicy = typeof tables.resourcePrivacy.$inferSelect;

export function boardRepairStateHash(board: BoardRow, policy: BoardPolicy | undefined): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        uuid: board.uuid,
        ownerId: board.ownerId,
        gymId: board.gymId,
        name: board.name,
        slug: board.slug,
        locationName: board.locationName,
        latitude: board.latitude,
        longitude: board.longitude,
        boardType: board.boardType,
        layoutId: board.layoutId,
        sizeId: board.sizeId,
        setIds: board.setIds,
        angle: board.angle,
        isAngleAdjustable: board.isAngleAdjustable,
        hasLeds: board.hasLeds,
        litByWallDevice: board.litByWallDevice,
        isPublic: board.isPublic,
        isUnlisted: board.isUnlisted,
        hideLocation: board.hideLocation,
        updatedAt: board.updatedAt.toISOString(),
        deletedAt: board.deletedAt?.toISOString() ?? null,
        mergedIntoBoardUuid: board.mergedIntoBoardUuid,
        policy: policy
          ? {
              ownerId: policy.ownerId,
              audience: policy.audience,
              locationAudience: policy.locationAudience,
              inheritFollowers: policy.inheritFollowers,
              revision: policy.revision,
            }
          : null,
      }),
    )
    .digest('hex');
}
