import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbTransaction } from '../db/after-commit';
import { userBoards } from '@boardsesh/db/schema';
import { GraphQLError } from 'graphql';
import { getPostgresErrorCode } from '../utils/postgres-errors';

/** Keep an active identity stable until a referencing write commits; merged UUIDs must be re-resolved by the caller. */
export async function lockActiveBoardForWrite(
  transaction: DbTransaction,
  identity: { id: number; uuid?: never } | { uuid: string; id?: never },
  options: { noWait?: boolean; lockTimeoutMs?: number } = {},
) {
  const lockBoard = async (executor: DbTransaction) => {
    const [board] = await executor
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
  };
  try {
    if (options.noWait || options.lockTimeoutMs === undefined) return await lockBoard(transaction);
    if (!Number.isSafeInteger(options.lockTimeoutMs) || options.lockTimeoutMs <= 0)
      throw new RangeError('A board lock timeout must be a positive integer number of milliseconds.');
    // A savepoint restores the caller's GUC and keeps its transaction usable
    // when the bounded wait times out. Successful row locks survive its release.
    return await transaction.transaction(async (boundedTransaction) => {
      const previous = Array.from(
        await boundedTransaction.execute<{ lockTimeout: string; lockTimeoutMs: number }>(sql`
        SELECT current_setting('lock_timeout') AS "lockTimeout", setting::integer AS "lockTimeoutMs"
        FROM pg_settings WHERE name = 'lock_timeout'
      `),
      )[0]!;
      const timeoutMs =
        previous.lockTimeoutMs === 0
          ? options.lockTimeoutMs!
          : Math.min(previous.lockTimeoutMs, options.lockTimeoutMs!);
      await boundedTransaction.execute(sql`SELECT set_config('lock_timeout', ${`${timeoutMs}ms`}, true)`);
      const board = await lockBoard(boundedTransaction);
      await boundedTransaction.execute(sql`SELECT set_config('lock_timeout', ${previous.lockTimeout}, true)`);
      return board;
    });
  } catch (error) {
    if (getPostgresErrorCode(error) === '55P03' || getPostgresErrorCode(error) === '40P01')
      throw new GraphQLError('This board is changing. Retry the same action.', { extensions: { code: 'CONFLICT' } });
    throw error;
  }
}
