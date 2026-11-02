/**
 * The board-catalogue snapshot contract: which tables the nightly catalogue
 * artifact carries, in the order a consumer must load them.
 *
 * Two packages read this. `packages/backend/src/scripts/export-board-catalog.ts`
 * builds the artifact from it; `packages/db/scripts/load-board-snapshots.ts`
 * loads the artifact into the seeded developer database from it. Keeping one
 * list means a table added to the export can never be silently skipped by the
 * loader — the drift would otherwise only surface as an empty table in an image
 * nobody rebuilds for weeks.
 *
 * See docs/board-snapshots.md → "Catalogue artifact".
 */

/**
 * Export and load order, which is foreign-key order: every table comes after
 * the tables its foreign keys point at. `board_placements` needs holes,
 * layouts, sets and roles; `board_leds` needs holes and product sizes;
 * `board_product_sizes_layouts_sets` needs layouts, sizes and sets.
 *
 * `deferred` marks the tables whose rows reference `board_climbs`, which lives
 * in the per-layout artifacts: they can only load after every layout has.
 */
export const CATALOG_SNAPSHOT_TABLES = [
  { name: 'board_products', deferred: false },
  { name: 'board_layouts', deferred: false },
  { name: 'board_product_sizes', deferred: false },
  { name: 'board_sets', deferred: false },
  { name: 'board_placement_roles', deferred: false },
  { name: 'board_holes', deferred: false },
  { name: 'board_placements', deferred: false },
  { name: 'board_leds', deferred: false },
  { name: 'board_product_sizes_layouts_sets', deferred: false },
  { name: 'board_kits', deferred: false },
  { name: 'board_difficulty_grades', deferred: false },
  { name: 'board_attempts', deferred: false },
  { name: 'board_climb_aliases', deferred: true },
  { name: 'board_beta_links', deferred: true },
] as const;

export type CatalogSnapshotTableName = (typeof CATALOG_SNAPSHOT_TABLES)[number]['name'];

/**
 * Columns dropped at export. `board_beta_links` links a video back to the
 * Boardsesh account that attached it, the tick it was attached to, and the
 * registered wall it was climbed on. Those ids resolve in exactly one database,
 * and the artifact is public — so they never leave production.
 */
export const CATALOG_SNAPSHOT_EXCLUDED_COLUMNS: Partial<Record<CatalogSnapshotTableName, readonly string[]>> = {
  board_beta_links: ['created_by_user_id', 'tick_uuid', 'board_id'],
};

/**
 * Columns exported as a presence marker instead of their value.
 *
 * Aurora gates some products and layouts behind a password, and the only thing
 * Boardsesh ever asks about that column is whether it is set —
 * `packages/web/app/lib/slug-utils.ts` filters public slugs with
 * `isNull(layouts.password)` and nothing anywhere reads the value. The artifact
 * is world-readable, so it carries a fixed sentinel where production has a
 * password and NULL where it does not: `IS NULL` behaves identically in a
 * database seeded from it, and the credential never leaves production.
 */
export const CATALOG_SNAPSHOT_REDACTED_COLUMNS: Partial<Record<CatalogSnapshotTableName, readonly string[]>> = {
  board_products: ['password'],
  board_layouts: ['password'],
};

/** What a redacted column holds when production has a value there. */
export const CATALOG_SNAPSHOT_REDACTED_VALUE = 'redacted';

/**
 * Board types whose rows never enter the artifact, from any table.
 *
 * A spray wall is a runtime-created catalogue layout: creating one writes the
 * climber's wall name into `board_layouts` / `board_product_sizes` and every
 * hold they mark into `board_holes` / `board_placements`. Those are private
 * rows, and the artifact is world-readable. The rows every wall shares (the
 * spray product, hold set, roles and grade scale) are seeded by migration 0227,
 * so a database built from the artifact still has them.
 *
 * The loader applies the same filter, so an older artifact that still carries
 * spray rows cannot put them back into a rebuilt developer image.
 */
export const CATALOG_SNAPSHOT_EXCLUDED_BOARD_TYPES = ['spray'] as const;

/** A bare or table-qualified lowercase SQL identifier, e.g. `board_type` or `board_layouts.board_type`. */
const SAFE_COLUMN_REFERENCE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/;

/**
 * `<column> NOT IN ('spray')` for a SQL WHERE clause. The values are the
 * literals above, never input, so splicing them is safe. `column` is spliced
 * too, so anything but a plain (optionally table-qualified) identifier throws.
 */
export function catalogSnapshotBoardTypeFilter(column: string): string {
  if (!SAFE_COLUMN_REFERENCE.test(column)) {
    throw new Error(`catalogSnapshotBoardTypeFilter: unsafe column reference ${JSON.stringify(column)}`);
  }
  const excluded = CATALOG_SNAPSHOT_EXCLUDED_BOARD_TYPES.map((boardType) => `'${boardType}'`).join(', ');
  return `${column} NOT IN (${excluded})`;
}

/**
 * Moves the two spray id sequences past any spray catalogue row already in the
 * database, and never backwards. One statement per sequence.
 *
 * A loaded artifact used to carry production's spray rows (ids 1, 2, 3, ...)
 * while both sequences still stood at 1, so the first wall created locally
 * collided with a row it could not see. The filter above stops new loads from
 * bringing those rows in; this keeps a database that already holds some from
 * handing out their ids again. A sequence is left alone when no row uses it.
 */
export const SPRAY_CATALOGUE_SEQUENCE_ADVANCE_SQL: readonly string[] = [
  {
    sequence: 'spray_wall_catalog_id_seq',
    tables: ['board_layouts', 'board_product_sizes', 'board_product_sizes_layouts_sets'],
  },
  { sequence: 'spray_hold_catalog_id_seq', tables: ['board_holes', 'board_placements'] },
].map(({ sequence, tables }) => {
  const maxIds = tables.map((table) => `COALESCE((SELECT max(id) FROM ${table} WHERE board_type = 'spray'), 0)`);
  return `WITH used AS (SELECT GREATEST(${maxIds.join(', ')}) AS max_id)
SELECT setval('${sequence}', GREATEST(used.max_id, (SELECT last_value FROM ${sequence})))
FROM used
WHERE used.max_id > 0`;
});

/**
 * For a deferred table, the column carrying a `board_climbs.uuid` that a
 * foreign key enforces. The loader filters on it: a climb updated inside the
 * export's stability window is absent from its layout artifact, and an alias
 * pointing at it would violate `board_climb_aliases_canonical_fk`.
 *
 * `board_beta_links.climb_uuid` has no such constraint, so it is not listed —
 * a beta link whose climb has not landed yet is stored, not dropped.
 */
export const CATALOG_SNAPSHOT_CLIMB_REFERENCE_COLUMNS: Partial<Record<CatalogSnapshotTableName, string>> = {
  board_climb_aliases: 'canonical_uuid',
};

/** Tables loaded before the per-layout climb artifacts, in order. */
export const catalogSnapshotBaseTables = (): CatalogSnapshotTableName[] =>
  CATALOG_SNAPSHOT_TABLES.filter((table) => !table.deferred).map((table) => table.name);

/** Tables loaded after every per-layout climb artifact, in order. */
export const catalogSnapshotDeferredTables = (): CatalogSnapshotTableName[] =>
  CATALOG_SNAPSHOT_TABLES.filter((table) => table.deferred).map((table) => table.name);
