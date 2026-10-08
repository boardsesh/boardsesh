import { asc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '@boardsesh/db/schema';
import type { Database } from '../../../db/client';
import { SYSTEM_BOARD_OWNER_ID } from '../board-presence/shared';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Retain scrubbed board IDs so another climber's old activity keeps its parent access cap. */
export async function deleteAccountBoards(tx: Transaction, userId: string): Promise<void> {
  // Called after the spray-wall lifecycle, under the account deletion lock.
  // Spray boards have already moved to the system owner at this point.
  const boards = await tx
    .select({ id: schema.userBoards.id })
    .from(schema.userBoards)
    .where(eq(schema.userBoards.ownerId, userId))
    .orderBy(asc(schema.userBoards.id))
    .for('update');
  if (boards.length === 0) return;
  const [systemOwner] = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, SYSTEM_BOARD_OWNER_ID))
    .limit(1);
  if (!systemOwner || userId === SYSTEM_BOARD_OWNER_ID)
    throw new Error('Board deletion requires the existing system owner');

  const deletedAt = new Date();
  await tx
    .update(schema.userBoards)
    .set({
      ownerId: SYSTEM_BOARD_OWNER_ID,
      deletedAt,
      updatedAt: deletedAt,
      name: 'Deleted board',
      slug: sql`'deleted-board-' || ${schema.userBoards.uuid}`,
      description: null,
      locationName: null,
      latitude: null,
      longitude: null,
      gymId: null,
      serialNumber: null,
      timerName: null,
      hideLocation: true,
      isPublic: false,
      isUnlisted: false,
      syncFrozenAt: deletedAt,
      mergedIntoBoardUuid: null,
    })
    .where(
      inArray(
        schema.userBoards.id,
        boards.map((board) => board.id),
      ),
    );
}
