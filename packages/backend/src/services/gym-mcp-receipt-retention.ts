import { and, eq, isNotNull, lte, or, sql } from 'drizzle-orm';
import { gymMcpWriteReceipts } from '@boardsesh/db/schema/auth';
import { db, type Database } from '../db/client';

const BATCH_SIZE = 1000;
const activeSweeps = new WeakMap<Database, Promise<number>>();

/** Keep retry identities permanently, draining expired payloads in short transactions. */
export function sweepGymMcpReceiptPayloads(database: Database = db, now = new Date()): Promise<number> {
  const activeSweep = activeSweeps.get(database);
  if (activeSweep) return activeSweep;
  const sweep = drainReceiptPayloads(database, now).finally(() => activeSweeps.delete(database));
  activeSweeps.set(database, sweep);
  return sweep;
}

async function drainReceiptPayloads(database: Database, now: Date): Promise<number> {
  let totalCleared = 0;
  let batchCleared: number;
  do {
    batchCleared = await clearReceiptPayloadBatch(database, now);
    totalCleared += batchCleared;
  } while (batchCleared === BATCH_SIZE);
  return totalCleared;
}

async function clearReceiptPayloadBatch(database: Database, now: Date): Promise<number> {
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select set_config('lock_timeout', '2s', true), set_config('statement_timeout', '5s', true)`,
    );
    const expired = await transaction
      .select({
        userId: gymMcpWriteReceipts.userId,
        clientId: gymMcpWriteReceipts.clientId,
        connectionGeneration: gymMcpWriteReceipts.connectionGeneration,
        idempotencyKey: gymMcpWriteReceipts.idempotencyKey,
      })
      .from(gymMcpWriteReceipts)
      .where(and(lte(gymMcpWriteReceipts.expiresAt, now), isNotNull(gymMcpWriteReceipts.result)))
      .orderBy(gymMcpWriteReceipts.expiresAt)
      .limit(BATCH_SIZE)
      .for('update', { skipLocked: true });
    if (expired.length === 0) return 0;
    const keys = expired.map((receipt) =>
      and(
        eq(gymMcpWriteReceipts.userId, receipt.userId),
        eq(gymMcpWriteReceipts.clientId, receipt.clientId),
        eq(gymMcpWriteReceipts.connectionGeneration, receipt.connectionGeneration),
        eq(gymMcpWriteReceipts.idempotencyKey, receipt.idempotencyKey),
      ),
    );
    await transaction
      .update(gymMcpWriteReceipts)
      .set({ result: null })
      .where(or(...keys));
    return expired.length;
  });
}
