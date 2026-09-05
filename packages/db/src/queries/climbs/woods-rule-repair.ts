import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { boardClimbs } from '../../schema/boards/unified';
export type WoodsRuleUpdate = {
  uuid: string;
  frames: string;
  sizeId: number;
  characteristics: string[];
  previousCharacteristics: string[] | null;
};

/** Must run inside the caller's transaction so a stale batch rolls back all writes. */
export async function applyWoodsRuleUpdates(
  transaction: Pick<PostgresJsDatabase, 'update'>,
  updates: WoodsRuleUpdate[],
): Promise<void> {
  const ruleArraySql = (tokens: string[] | null) =>
    tokens === null
      ? sql`NULL::text[]`
      : sql`ARRAY[${sql.join(
          tokens.map((token) => sql`${token}`),
          sql`, `,
        )}]::text[]`;
  // One request per batch keeps remote repairs bounded by 54 round trips,
  // rather than 5,392 individual updates for the audited catalog.
  for (let offset = 0; offset < updates.length; offset += 100) {
    const batch = updates.slice(offset, offset + 100);
    const cases = batch.map((update) => sql`WHEN ${update.uuid} THEN ${ruleArraySql(update.characteristics)}`);
    const predicates = batch.map((update) =>
      and(
        eq(boardClimbs.uuid, update.uuid),
        eq(boardClimbs.frames, update.frames),
        sql`${boardClimbs.characteristics} IS NOT DISTINCT FROM ${ruleArraySql(update.previousCharacteristics)}`,
      ),
    );
    const changed = await transaction
      .update(boardClimbs)
      .set({
        characteristics: sql`CASE ${boardClimbs.uuid} ${sql.join(cases, sql` `)} ELSE ${boardClimbs.characteristics} END`,
      })
      .where(and(eq(boardClimbs.boardType, 'woods'), isNull(boardClimbs.userId), or(...predicates)))
      .returning({ uuid: boardClimbs.uuid });
    if (changed.length !== batch.length) throw new Error('Woods climbs changed during repair; transaction rolled back');
  }
}
