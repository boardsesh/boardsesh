import { and, eq, isNull } from 'drizzle-orm';
import type { DbTransaction } from '../db/after-commit';
import { userBoards } from '@boardsesh/db/schema';
import { GraphQLError } from 'graphql';
import { getPostgresErrorCode } from '../utils/postgres-errors';

/** Keep an active identity stable until a referencing write commits; merged UUIDs must be re-resolved by the caller. */
export async function lockActiveBoardForWrite(
  transaction: DbTransaction,
  identity: { id: number; uuid?: never } | { uuid: string; id?: never },
  options: { noWait?: boolean } = {},
) {
  try {
    const [board] = await transaction
      .select()
      .from(userBoards)
      .where(
        and(
          identity.id === undefined ? eq(userBoards.uuid, identity.uuid) : eq(userBoards.id, identity.id),
          isNull(userBoards.deletedAt),
          isNull(userBoards.mergedIntoBoardUuid),
        ),
      )
      .for('share', options.noWait ? { noWait: true } : undefined)
      .limit(1);
    return board ?? null;
  } catch (error) {
    if (getPostgresErrorCode(error) === '55P03')
      throw new GraphQLError('This board is changing. Retry the same action.', { extensions: { code: 'CONFLICT' } });
    throw error;
  }
}
