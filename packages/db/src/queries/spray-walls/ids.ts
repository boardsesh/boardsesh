import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { rowsOf } from '../util/rows';

// Any drizzle-orm PgDatabase (postgres-js client, the script client, the Neon
// HTTP client the web app uses) and the PgTransaction handle backend resolvers
// run inside all satisfy this.
type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** The catalogue ids a new spray wall occupies. */
export type SprayWallIds = {
  /** The wall's `board_layouts.id`. */
  layoutId: number;
  /** The wall's `board_product_sizes.id` — the SAME number as `layoutId`. */
  sizeId: number;
};

/**
 * Take the next wall id out of `spray_wall_catalog_id_seq`.
 *
 * ONE sequence value becomes BOTH the layout id and the size id, because a wall
 * has exactly one size — itself (`spraySizeIdForLayout`). Drawing a second value
 * for the size would leave the two id spaces holding the same numbers offset by
 * however many walls had been created, which every join between them would then
 * have to un-pick.
 *
 * `nextval` is transaction-safe and never rolls back, so two concurrent wall
 * creations can never be handed the same id.
 */
export async function allocateWallIds(db: DrizzleDb): Promise<SprayWallIds> {
  const rows = rowsOf<{ id: string | number }>(
    await db.execute(sql`SELECT nextval('spray_wall_catalog_id_seq') AS id`),
  );
  const layoutId = Number(rows[0]?.id);
  if (!Number.isFinite(layoutId)) {
    throw new Error('spray_wall_catalog_id_seq returned no id');
  }
  return { layoutId, sizeId: layoutId };
}

/**
 * Take `count` hold ids out of `spray_hold_catalog_id_seq`, in one round trip.
 *
 * Each value is BOTH a `board_holes.id` and a `board_placements.id` — a wall
 * hold has no separate hole to mount into, and a climb's frames string
 * (`p<placementId>r<code>`) has to resolve to the same row the wall editor
 * drew. Ids come back ascending, which the hold editor relies on to keep a
 * freshly detected batch in the order it was reviewed.
 */
export async function allocateHoldIds(db: DrizzleDb, count: number): Promise<number[]> {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`allocateHoldIds needs a non-negative integer count, got ${count}`);
  }
  if (count === 0) return [];
  const rows = rowsOf<{ id: string | number }>(
    await db.execute(sql`SELECT nextval('spray_hold_catalog_id_seq') AS id FROM generate_series(1, ${count})`),
  );
  return rows.map((row) => Number(row.id));
}
