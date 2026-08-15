import { and, eq, isNull, ne } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { normaliseSetIds } from '@boardsesh/board-config';
import { lockBoardSerialWrite, type BoardSerialWriteCommandDb } from '@boardsesh/db/queries';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../db/client';

export { lockBoardSerialWrite };
export type { BoardSerialWriteCommandDb };

export type BoardSerialGuardInput = {
  serialNumber?: string | null;
  allowDuplicateSerial?: boolean;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
};

type BoardSerialGuardDb = BoardSerialWriteCommandDb & Pick<typeof db, 'select'>;

/**
 * Raised when a normal board write would recreate the exact cross-owner
 * duplicate that the serial resolver/dedupe treats as one physical wall.
 * Identifying fields stay masked for private boards.
 */
function duplicateSerialAcrossOwnersError(existing: {
  uuid: string;
  slug: string;
  name: string;
  isPublic: boolean;
}): GraphQLError {
  return new GraphQLError('That serial is already registered to another board', {
    extensions: {
      code: 'BOARD_SERIAL_EXISTS',
      ...(existing.isPublic ? { boardUuid: existing.uuid, slug: existing.slug, name: existing.name } : {}),
    },
  });
}

/**
 * Lock a serial, then reject an active same-config board owned by somebody
 * else. `allowDuplicateSerial` is the explicit user-confirmed escape hatch and
 * deliberately skips the guard only; it still participates in serialization.
 */
export async function lockAndAssertBoardSerialAvailable(
  commandDb: BoardSerialGuardDb,
  input: BoardSerialGuardInput,
  ownerId: string,
  excludeBoardId?: number,
): Promise<void> {
  if (!input.serialNumber) return;

  await lockBoardSerialWrite(commandDb, input.serialNumber);
  // The user-confirmed override permits a duplicate, but it still waits its
  // turn. Otherwise a normal creator could check an empty serial concurrently
  // and insert without ever observing the override's board.
  if (input.allowDuplicateSerial === true) return;

  const normalizedSetIds = normaliseSetIds(input.setIds);
  const otherOwnerBoards = await commandDb
    .select({
      id: dbSchema.userBoards.id,
      uuid: dbSchema.userBoards.uuid,
      slug: dbSchema.userBoards.slug,
      name: dbSchema.userBoards.name,
      setIds: dbSchema.userBoards.setIds,
      isPublic: dbSchema.userBoards.isPublic,
    })
    .from(dbSchema.userBoards)
    .where(
      and(
        eq(dbSchema.userBoards.serialNumber, input.serialNumber),
        eq(dbSchema.userBoards.boardType, input.boardType),
        eq(dbSchema.userBoards.layoutId, input.layoutId),
        eq(dbSchema.userBoards.sizeId, input.sizeId),
        ne(dbSchema.userBoards.ownerId, ownerId),
        isNull(dbSchema.userBoards.deletedAt),
        excludeBoardId === undefined ? undefined : ne(dbSchema.userBoards.id, excludeBoardId),
      ),
    );
  const conflict = otherOwnerBoards.find((row) => normaliseSetIds(row.setIds) === normalizedSetIds);
  if (conflict) throw duplicateSerialAcrossOwnersError(conflict);
}
