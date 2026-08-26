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
