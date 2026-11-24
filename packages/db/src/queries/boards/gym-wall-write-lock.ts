import { sql } from 'drizzle-orm';
import type { BoardSerialWriteCommandDb } from './serial-write-lock';

// Two-int advisory-lock namespace (ASCII "GWAL", gym wall) for createBoard's
// existing-wall recheck (#8151). Distinct from every other namespace in the
// repo: board serials use "BSRL" (0x4253524c), the gym-claim auto-approve lock
// uses (8043, 1), and the rest are listed in docs/product/existing-wall-check.md.
const GYM_WALL_WRITE_LOCK_NAMESPACE = 0x4757414c;

// The two-int form takes int4 keys and gym ids are bigserial. Folding the id
// into int4 range keeps every real id (far below 2^31) on its own key; a fold
// collision past that only serializes two unrelated gyms, never shares state.
const INT4_KEY_SPACE = 2 ** 31;

/**
 * Serialize board creates that check a gym's existing walls, so two climbers
 * adding the same wall at the same moment can't both see "no wall yet" and
 * both insert. Locks every gym id given, deduped and in ascending order, so two
 * creates whose search areas overlap always take the shared locks in the same
 * order and can't deadlock.
 *
 * The caller keeps the check and the insert in this same transaction, and takes
 * these locks before the board-serial lock (`lockBoardSerialWrite`).
 */
export async function lockGymWallWrites(
  commandDb: BoardSerialWriteCommandDb,
  gymIds: readonly number[],
): Promise<void> {
  // Sorted by the key actually locked, not the raw id, so the order stays
  // consistent even for ids past the fold.
  const orderedLockKeys = [...new Set(gymIds.map((gymId) => gymId % INT4_KEY_SPACE))].sort(
    (first, second) => first - second,
  );
  for (const lockKey of orderedLockKeys) {
    await commandDb.execute(sql`SELECT pg_advisory_xact_lock(${GYM_WALL_WRITE_LOCK_NAMESPACE}::int, ${lockKey}::int)`);
  }
}
