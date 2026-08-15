import { sql, type SQLWrapper } from 'drizzle-orm';

export type BoardSerialWriteCommandDb = {
  execute(query: SQLWrapper | string): PromiseLike<unknown>;
};

// Two-int advisory-lock namespace (ASCII "BSRL") keeps hardware-serial writes
// separate from every other lock family sharing the PostgreSQL cluster.
const BOARD_SERIAL_WRITE_LOCK_NAMESPACE = 0x4253524c;

/**
 * Serialize writes and maintenance work for one hardware serial. PostgreSQL's
 * hashtext result is 32-bit, so unrelated serials can theoretically collide;
 * that only causes safe false contention (extra serialization), never shared
 * state or an incorrect merge.
 *
 * The caller must keep the protected work in this same transaction. Code that
 * also locks board rows must acquire those row locks before this serial lock.
 */
export async function lockBoardSerialWrite(commandDb: BoardSerialWriteCommandDb, serial: string): Promise<void> {
  await commandDb.execute(sql`SELECT pg_advisory_xact_lock(${BOARD_SERIAL_WRITE_LOCK_NAMESPACE}, hashtext(${serial}))`);
}
