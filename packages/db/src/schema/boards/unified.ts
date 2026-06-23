import {
  pgTable,
  foreignKey,
  bigserial,
  text,
  integer,
  doublePrecision,
  boolean,
  bigint,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../auth/users';

// =============================================================================
// Reference Tables (Phase 1)
// =============================================================================

export const boardAttempts = pgTable(
  'board_attempts',
  {
    boardType: text('board_type').notNull(),
    id: integer().notNull(),
    position: integer(),
    name: text(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.id] }),
  }),
);

export const boardDifficultyGrades = pgTable(
  'board_difficulty_grades',
  {
    boardType: text('board_type').notNull(),
    difficulty: integer().notNull(),
    boulderName: text('boulder_name'),
    routeName: text('route_name'),
    isListed: boolean('is_listed'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.difficulty] }),
  }),
);

// =============================================================================
// Product Configuration Tables (Phase 2)
// =============================================================================

export const boardProducts = pgTable(
  'board_products',
  {
    boardType: text('board_type').notNull(),
    id: integer().notNull(),
    name: text(),
    isListed: boolean('is_listed'),
    password: text(),
    minCountInFrame: integer('min_count_in_frame'),
    maxCountInFrame: integer('max_count_in_frame'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.id] }),
  }),
);

export const boardSets = pgTable(
  'board_sets',
  {
    boardType: text('board_type').notNull(),
    id: integer().notNull(),
    name: text(),
    hsm: integer(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.id] }),
  }),
);

export const boardProductSizes = pgTable(
  'board_product_sizes',
  {
    boardType: text('board_type').notNull(),
    id: integer().notNull(),
    productId: integer('product_id').notNull(),
    edgeLeft: integer('edge_left'),
    edgeRight: integer('edge_right'),
    edgeBottom: integer('edge_bottom'),
    edgeTop: integer('edge_top'),
    name: text(),
    description: text(),
    imageFilename: text('image_filename'),
    position: integer(),
    isListed: boolean('is_listed'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.id] }),
    productFk: foreignKey({
      columns: [table.boardType, table.productId],
      foreignColumns: [boardProducts.boardType, boardProducts.id],
      name: 'board_product_sizes_product_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  }),
);

export const boardLayouts = pgTable(
  'board_layouts',
  {
    boardType: text('board_type').notNull(),
    id: integer().notNull(),
    productId: integer('product_id'),
    name: text(),
    instagramCaption: text('instagram_caption'),
    isMirrored: boolean('is_mirrored'),
    isListed: boolean('is_listed'),
    password: text(),
    createdAt: text('created_at'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.id] }),
    productFk: foreignKey({
      columns: [table.boardType, table.productId],
      foreignColumns: [boardProducts.boardType, boardProducts.id],
      name: 'board_layouts_product_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  }),
);

export const boardHoles = pgTable(
  'board_holes',
  {
    boardType: text('board_type').notNull(),
    id: integer().notNull(),
    productId: integer('product_id'),
    name: text(),
    x: integer(),
    y: integer(),
    mirroredHoleId: integer('mirrored_hole_id'),
    mirrorGroup: integer('mirror_group').default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.id] }),
    productFk: foreignKey({
      columns: [table.boardType, table.productId],
      foreignColumns: [boardProducts.boardType, boardProducts.id],
      name: 'board_holes_product_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  }),
);

export const boardPlacementRoles = pgTable(
  'board_placement_roles',
  {
    boardType: text('board_type').notNull(),
    id: integer().notNull(),
    productId: integer('product_id'),
    position: integer(),
    name: text(),
    fullName: text('full_name'),
    ledColor: text('led_color'),
    screenColor: text('screen_color'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.id] }),
    productFk: foreignKey({
      columns: [table.boardType, table.productId],
      foreignColumns: [boardProducts.boardType, boardProducts.id],
      name: 'board_placement_roles_product_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  }),
);

export const boardLeds = pgTable(
  'board_leds',
  {
    boardType: text('board_type').notNull(),
    id: integer().notNull(),
    productSizeId: integer('product_size_id'),
    holeId: integer('hole_id'),
    position: integer(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.id] }),
    productSizeFk: foreignKey({
      columns: [table.boardType, table.productSizeId],
      foreignColumns: [boardProductSizes.boardType, boardProductSizes.id],
      name: 'board_leds_product_size_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    holeFk: foreignKey({
      columns: [table.boardType, table.holeId],
      foreignColumns: [boardHoles.boardType, boardHoles.id],
      name: 'board_leds_hole_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  }),
);

export const boardPlacements = pgTable(
  'board_placements',
  {
    boardType: text('board_type').notNull(),
    id: integer().notNull(),
    layoutId: integer('layout_id'),
    holeId: integer('hole_id'),
    setId: integer('set_id'),
    defaultPlacementRoleId: integer('default_placement_role_id'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.id] }),
    climbHoldLookupIdx: index('board_placements_board_type_layout_id_set_hole_idx').on(
      table.boardType,
      table.layoutId,
      table.id,
      table.setId,
      table.holeId,
    ),
    layoutFk: foreignKey({
      columns: [table.boardType, table.layoutId],
      foreignColumns: [boardLayouts.boardType, boardLayouts.id],
      name: 'board_placements_layout_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    holeFk: foreignKey({
      columns: [table.boardType, table.holeId],
      foreignColumns: [boardHoles.boardType, boardHoles.id],
      name: 'board_placements_hole_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    setFk: foreignKey({
      columns: [table.boardType, table.setId],
      foreignColumns: [boardSets.boardType, boardSets.id],
      name: 'board_placements_set_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    roleFk: foreignKey({
      columns: [table.boardType, table.defaultPlacementRoleId],
      foreignColumns: [boardPlacementRoles.boardType, boardPlacementRoles.id],
      name: 'board_placements_role_fk',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  }),
);

export const boardProductSizesLayoutsSets = pgTable(
  'board_product_sizes_layouts_sets',
  {
    boardType: text('board_type').notNull(),
    id: integer().notNull(),
    productSizeId: integer('product_size_id'),
    layoutId: integer('layout_id'),
    setId: integer('set_id'),
    imageFilename: text('image_filename'),
    isListed: boolean('is_listed'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.id] }),
    productSizeFk: foreignKey({
      columns: [table.boardType, table.productSizeId],
      foreignColumns: [boardProductSizes.boardType, boardProductSizes.id],
      name: 'board_psls_product_size_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    layoutFk: foreignKey({
      columns: [table.boardType, table.layoutId],
      foreignColumns: [boardLayouts.boardType, boardLayouts.id],
      name: 'board_psls_layout_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    setFk: foreignKey({
      columns: [table.boardType, table.setId],
      foreignColumns: [boardSets.boardType, boardSets.id],
      name: 'board_psls_set_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  }),
);

// =============================================================================
// Core Climb Tables (Phase 3)
// =============================================================================

export const boardClimbs = pgTable(
  'board_climbs',
  {
    uuid: text().primaryKey().notNull(),
    boardType: text('board_type').notNull(),
    layoutId: integer('layout_id').notNull(),
    setterId: integer('setter_id'),
    setterUsername: text('setter_username'),
    name: text(),
    description: text().default(''),
    hsm: integer(),
    edgeLeft: integer('edge_left'),
    edgeRight: integer('edge_right'),
    edgeBottom: integer('edge_bottom'),
    edgeTop: integer('edge_top'),
    angle: integer(),
    framesCount: integer('frames_count').default(1),
    framesPace: integer('frames_pace').default(0),
    frames: text(),
    isDraft: boolean('is_draft').default(false),
    isListed: boolean('is_listed'),
    createdAt: text('created_at'),
    // Timestamp of the first non-draft save. Null while the climb is still a
    // draft. Used by the create-climb form to gate the post-publish edit window
    // (users can continue tweaking a published climb for 24h).
    publishedAt: text('published_at'),
    synced: boolean('synced').default(true).notNull(),
    syncError: text('sync_error'),
    // Boardsesh user who created this climb locally (null for Aurora-synced climbs)
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    // Denormalized: which hold sets does this climb require? (from climb_holds → placements)
    requiredSetIds: integer('required_set_ids').array(),
    // Denormalized: which product_size IDs can display this climb? (from edge comparison)
    compatibleSizeIds: integer('compatible_size_ids').array(),
    // SHA-256 fingerprint of the climb's hold layout. Sorted
    // (hold_id:hold_state:frame_number) tuples joined with '|' then hashed.
    // Two climbs with the same fingerprint at the same (board_type, layout_id)
    // are duplicates; the dedup path in kilter-sync writes one canonical
    // board_climbs row and routes additional UUIDs through board_climb_aliases.
    holdFingerprint: text('hold_fingerprint'),
    // Structured climb characteristics — the replacement for the magic strings
    // that used to live in `description` (Aurora's "No match" prefix) and the
    // MoonBoard "method" the importer dropped. Tokens: 'no_match',
    // 'method_footless', 'method_footless_kickboard', 'method_no_kickboard'
    // (see @boardsesh/shared-schema CLIMB_CHARACTERISTICS). Internal reads/filters
    // use this array; the description prefix stays only as the Aurora wire format.
    // A GIN index (board_climbs_characteristics_idx) is created in a custom
    // migration — like compatible_size_ids' GIN index (migration 0073), kept out
    // of the schema so drizzle-kit generate never emits a destructive diff for it.
    characteristics: text('characteristics').array(),
  },
  (table) => ({
    boardTypeIdx: index('board_climbs_board_type_idx').on(table.boardType),
    // Dedup hot path: look up an existing canonical row for an incoming climb
    // by (board_type, layout_id, fingerprint) before deciding whether to
    // insert as canonical or upsert as an alias.
    holdFingerprintIdx: index('board_climbs_hold_fingerprint_idx').on(
      table.boardType,
      table.layoutId,
      table.holdFingerprint,
    ),
    // Combined index covering the full WHERE clause of the main climb search query
    // Replaces separate layout_filter and edges indexes to avoid bitmap AND merges
    searchFilterIdx: index('board_climbs_search_filter_idx').on(
      table.boardType,
      table.layoutId,
      table.isListed,
      table.isDraft,
      table.framesCount,
      table.edgeLeft,
      table.edgeRight,
      table.edgeBottom,
      table.edgeTop,
    ),
    setterUsernameIdx: index('board_climbs_setter_username_idx').on(table.boardType, table.setterUsername),
    userIdIdx: index('board_climbs_user_id_idx')
      .on(table.userId)
      .where(sql`${table.userId} IS NOT NULL AND ${table.isDraft} = false`),
    // Index for climb name lookups (used by JSON import to resolve names to UUIDs)
    nameIdx: index('board_climbs_name_idx').on(table.boardType, table.name),
    // Note: a GIN index on compatible_size_ids already exists from migration 0073
    // (board_climbs_compatible_size_ids_idx); the recommendation size filter uses
    // `compatible_size_ids @> ARRAY[sizeId]` so it can use that existing index.
    // Note: No FK to board_layouts - climbs may reference layouts that don't exist during sync
  }),
);

// board_climb_aliases maps duplicate Kilter UUIDs onto a single canonical
// board_climbs row. The Kilter catalog occasionally publishes the same
// physical climb (same holds, same layout) under multiple UUIDs with
// different names or setters; without this table each duplicate would
// fracture per-climb stats across separate rows.
//
// Every climb has at least a self-alias (alias_uuid = canonical_uuid)
// inserted during ingest so downstream lookups never miss. The dedup logic
// lives in packages/kilter-sync; this table is just the storage layer.
//
// FK asymmetry — by design:
//   - canonical_uuid → board_climbs.uuid is a hard FK. Canonical rows always
//     exist in board_climbs; if a canonical climb gets deleted we want the
//     alias rows that point at it to go too (ON DELETE CASCADE).
//   - alias_uuid has no FK to board_climbs.uuid. The whole point of the
//     dedup path is that we skip inserting a board_climbs row for duplicate
//     UUIDs — the alias_uuid is precisely the UUID we did NOT promote to
//     board_climbs. A FK would block every non-canonical insert.
//
// last_seen_at is refreshed on every ingest via ON CONFLICT DO UPDATE
// (`source` and `last_seen_at` are the only mutable columns); first_seen_at
// is stamped on insert and never touched again.
//
// Resolving a UUID to its canonical: see resolveCanonicalClimbUuid() in
// packages/db/src/queries/aliases.ts.
export const boardClimbAliases = pgTable(
  'board_climb_aliases',
  {
    boardType: text('board_type').notNull(),
    aliasUuid: text('alias_uuid').notNull(),
    canonicalUuid: text('canonical_uuid').notNull(),
    // 'kilter' | 'aurora' | 'backfill' | … — origin of the alias. Lets us
    // reason about why a row exists without parsing UUID formats.
    source: text('source').notNull(),
    firstSeenAt: timestamp('first_seen_at').defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.aliasUuid] }),
    canonicalIdx: index('board_climb_aliases_canonical_idx').on(table.boardType, table.canonicalUuid),
    canonicalFk: foreignKey({
      columns: [table.canonicalUuid],
      foreignColumns: [boardClimbs.uuid],
      name: 'board_climb_aliases_canonical_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    uuidsNonEmpty: check(
      'board_climb_aliases_uuids_non_empty',
      sql`${table.aliasUuid} <> '' AND ${table.canonicalUuid} <> ''`,
    ),
  }),
);

// Maps a Kilter Grips `product_layout_uuid` (a small integer-as-string,
// e.g. "27") onto the integer `board_layouts.id` the rest of board_* uses.
// Kilter Grips ships finer-grained layout variants than the legacy Aurora
// catalog (many Grips layouts → one board_layouts row, keyed by product),
// and its climbs reference layouts by this uuid. The catalog sync resolves
// the mapping once per run (by product name / single-layout fallback) and
// persists it here so it survives restarts and so the per-user paths
// (mounting holes, ticks that carry product_layout_uuid) can reuse it.
//
// Unlike board_climb_aliases.alias_uuid, layout_id is a hard FK — it always
// references an existing board_layouts row (we never invent layouts here).
// source records how the mapping was derived ('name' | 'single-layout' |
// 'manual'); last_seen_at refreshes on every ingest.
export const boardLayoutAliases = pgTable(
  'board_layout_aliases',
  {
    boardType: text('board_type').notNull(),
    layoutUuid: text('layout_uuid').notNull(),
    layoutId: integer('layout_id').notNull(),
    source: text('source').notNull(),
    firstSeenAt: timestamp('first_seen_at').defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.layoutUuid] }),
    layoutIdx: index('board_layout_aliases_layout_idx').on(table.boardType, table.layoutId),
    layoutFk: foreignKey({
      columns: [table.boardType, table.layoutId],
      foreignColumns: [boardLayouts.boardType, boardLayouts.id],
      name: 'board_layout_aliases_layout_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    layoutUuidNonEmpty: check('board_layout_aliases_uuid_non_empty', sql`${table.layoutUuid} <> ''`),
  }),
);

// Per-user-per-climb rating, separate from the per-tick quality/difficulty
// pair on boardsesh_ticks. Kilter exposes ratings as their own first-class
// resource (POST /api/climb-rating/) and we need a stable home for both
// the pulled-down rows and the rows we push back, so this is its own
// table rather than columns on boardsesh_ticks. The aurora-equivalent
// path could adopt it later; for v1 only kilter-sync writes here.
//
// kilter_id and aurora_id are nullable surrogate keys with partial
// unique indexes (WHERE … IS NOT NULL) — a single row can carry both
// (e.g. a rating that originated in Aurora and then Kilter mirrored it
// back), and Boardsesh-originated rows carry neither until a sync
// adopts them.
export const boardClimbRatings = pgTable(
  'board_climb_ratings',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    boardType: text('board_type').notNull(),
    climbUuid: text('climb_uuid').notNull(),
    angle: integer('angle').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rating: integer('rating'),
    // Opaque Kilter `difficulty_grade_id` — no FK to a local grades
    // table because that mapping is owned upstream and may add new
    // grade IDs we haven't synced yet. Treat as a pass-through integer
    // and resolve to a display string at read time via the existing
    // grade-lookup tables.
    difficultyGradeId: integer('difficulty_grade_id'),
    comment: text('comment').default(''),
    weight: doublePrecision('weight'),
    kilterId: text('kilter_id'),
    auroraId: text('aurora_id'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    // No `ON UPDATE` trigger — matches the project-wide convention (see
    // boardsesh_ticks, playlists, etc.). Every writer is responsible for
    // explicitly setting `updatedAt: new Date()` in its UPDATE/upsert
    // SET clause. Drift here is a real risk; centralising it via a
    // trigger is a follow-up that affects every table at once.
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    uniqueUserClimbAngle: uniqueIndex('board_climb_ratings_user_climb_angle_idx').on(
      table.boardType,
      table.climbUuid,
      table.angle,
      table.userId,
    ),
    // Note: a standalone user_id index would be redundant — the unique
    // index on (board_type, climb_uuid, angle, user_id) already covers
    // user lookups for our queries, which always constrain board_type.
    // Surrogate-key unique indexes scoped to rows that actually carry
    // the surrogate (WHERE … IS NOT NULL). Without the partial
    // predicate the unique constraint only kicks in by accident of
    // Postgres' "NULLs are distinct" behaviour — relying on that
    // misleads readers and breaks if we ever tighten the schema.
    kilterIdUnique: uniqueIndex('board_climb_ratings_kilter_id_unique')
      .on(table.kilterId)
      .where(sql`${table.kilterId} IS NOT NULL`),
    auroraIdUnique: uniqueIndex('board_climb_ratings_aurora_id_unique')
      .on(table.auroraId)
      .where(sql`${table.auroraId} IS NOT NULL`),
    // Compound index on the kilter-sync REMOVE delete path:
    // `WHERE user_id = $1 AND kilter_id IN (…)`. The partial unique
    // on kilter_id alone forces Postgres to filter on the surrogate
    // then re-check user_id row by row — fine at the current scale,
    // a near-table-scan once we have millions of ratings.
    userKilterIdx: index('board_climb_ratings_user_kilter_idx')
      .on(table.userId, table.kilterId)
      .where(sql`${table.kilterId} IS NOT NULL`),
    // Kilter's published range is 1–5 (and NULL for "no opinion yet").
    // Constrain at the DB so a bad PowerSync payload can't poison the
    // table — the sync writer has no opportunity to validate before the
    // bulk upsert, so the DB is the right enforcement point.
    ratingRangeCheck: check(
      'board_climb_ratings_rating_range',
      sql`${table.rating} IS NULL OR (${table.rating} >= 1 AND ${table.rating} <= 5)`,
    ),
  }),
);

export const boardClimbStats = pgTable(
  'board_climb_stats',
  {
    boardType: text('board_type').notNull(),
    climbUuid: text('climb_uuid').notNull(),
    angle: integer('angle').notNull(),
    displayDifficulty: doublePrecision('display_difficulty'),
    benchmarkDifficulty: doublePrecision('benchmark_difficulty'),
    // ascensionistCount is the materialized total kept in sync by three writers:
    // Aurora sync updates aurora_ascensionist_count + ascensionist_count in one
    // statement; Kilter sync updates kilter_ascensionist_count +
    // ascensionist_count in one statement; the Boardsesh tick recompute updates
    // boardsesh_ascensionist_count + ascensionist_count in one statement. Kilter
    // and Aurora are alternate upstream snapshots, so totals use the higher of
    // those two plus Boardsesh, not their sum.
    // Keep it as a regular column (not GENERATED) so the custom covering indexes
    // (board_climb_stats_ascents_covering_idx, migration 0068; the v2 variant with
    // climb_uuid as a trailing key column, migration 0122) keep working.
    ascensionistCount: bigint('ascensionist_count', { mode: 'number' }),
    auroraAscensionistCount: bigint('aurora_ascensionist_count', { mode: 'number' }),
    kilterAscensionistCount: bigint('kilter_ascensionist_count', { mode: 'number' }),
    boardseshAscensionistCount: bigint('boardsesh_ascensionist_count', { mode: 'number' }),
    difficultyAverage: doublePrecision('difficulty_average'),
    qualityAverage: doublePrecision('quality_average'),
    // True once quality_average is on the canonical 1-5 scale. Aurora reports
    // quality on 1-3; Kilter Grips / MoonBoard / Boardsesh ticks are already
    // 1-5. The 1-3→1-5 backfill (migration 0115/0116) and every write path set
    // this so the one-time conversion never double-applies. Transitional: once
    // every row is normalized this column can be dropped (follow-up).
    qualityNormalized: boolean('quality_normalized').notNull().default(false),
    faUsername: text('fa_username'),
    faAt: timestamp('fa_at', { mode: 'string' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.climbUuid, table.angle] }),
    // Note: the ascents/quality covering indexes are created in custom migrations
    // (0068/0121, and the v2 climb_uuid-as-key variants in 0122) with DESC NULLS LAST
    // + INCLUDE columns that Drizzle can't express.
    // Do NOT add an ascents/quality index here — it would conflict with those custom
    // migrations and make drizzle-kit generate emit destructive diffs.
    // Note: No FK to board_climbs - stats may arrive before their corresponding climbs during sync
  }),
);

export const boardClimbHolds = pgTable(
  'board_climb_holds',
  {
    boardType: text('board_type').notNull(),
    climbUuid: text('climb_uuid').notNull(),
    holdId: integer('hold_id').notNull(),
    frameNumber: integer('frame_number').notNull(),
    holdState: text('hold_state').notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.climbUuid, table.holdId] }),
    holdSearchIdx: index('board_climb_holds_search_idx').on(table.boardType, table.holdId, table.holdState),
    climbFk: foreignKey({
      columns: [table.climbUuid],
      foreignColumns: [boardClimbs.uuid],
      name: 'board_climb_holds_climb_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  }),
);

export const boardClimbStatsHistory = pgTable(
  'board_climb_stats_history',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    boardType: text('board_type').notNull(),
    climbUuid: text('climb_uuid').notNull(),
    angle: integer('angle').notNull(),
    displayDifficulty: doublePrecision('display_difficulty'),
    benchmarkDifficulty: doublePrecision('benchmark_difficulty'),
    ascensionistCount: bigint('ascensionist_count', { mode: 'number' }),
    difficultyAverage: doublePrecision('difficulty_average'),
    qualityAverage: doublePrecision('quality_average'),
    faUsername: text('fa_username'),
    faAt: timestamp('fa_at', { mode: 'string' }),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => ({
    boardTypeClimbIdx: index('board_climb_stats_history_lookup_idx').on(table.boardType, table.climbUuid, table.angle),
  }),
);

export const boardBetaLinks = pgTable(
  'board_beta_links',
  {
    boardType: text('board_type').notNull(),
    climbUuid: text('climb_uuid').notNull(),
    link: text().notNull(),
    foreignUsername: text('foreign_username'),
    angle: integer(),
    thumbnail: text(),
    isListed: boolean('is_listed'),
    createdAt: text('created_at'),
    // Optional direct ascent this beta was attached to. Legacy rows can stay
    // null and are still matched by climb/angle/user heuristics on read.
    //
    // ⚠️ FK managed manually — there's a foreign key
    //   `board_beta_links_tick_uuid_boardsesh_ticks_uuid_fk`
    //   referencing `boardsesh_ticks(uuid) ON DELETE SET NULL`, added in
    //   migration `0128_direct_beta_tick_links.sql`. It is NOT declared via
    //   `.references()` here because this schema avoids cross-package FKs.
    //   Drizzle-kit's snapshot does NOT know about this FK. The next
    //   `drizzle-kit generate` run against this table may emit SQL that
    //   drops it — always review generated migrations for this column.
    tickUuid: text('tick_uuid'),
    // Optional physical board this beta was recorded on. Set alongside
    // tickUuid when the ascent has a resolved user_boards row.
    // Stored as bigint in Postgres; exposed as GraphQL Int (safe for
    // auto-increment IDs that fit in 32 bits, but not the general case).
    //
    // ⚠️ FK managed manually — there's a foreign key
    //   `board_beta_links_board_id_user_boards_id_fk`
    //   referencing `user_boards(id) ON DELETE SET NULL`, added in
    //   migration `0128_direct_beta_tick_links.sql`. It is NOT declared via
    //   `.references()` here to avoid cross-package FKs.
    //   Drizzle-kit's snapshot does NOT know about this FK. The next
    //   `drizzle-kit generate` run may emit SQL that drops it — always
    //   review generated migrations for this column.
    boardId: bigint('board_id', { mode: 'number' }),
    // Platform-stable identifier extracted from `link` at write time.
    // Currently only populated for Instagram URLs (the post/reel shortcode);
    // null for TikTok and other platforms. Used as the indexed key for the
    // cross-climb dedup check so we don't have to LIKE-scan every row.
    shortcode: text('shortcode'),
    // Canonical video identity across supported platforms. This lets the same
    // video be tied to exactly one tick even when the URL text differs by host
    // or tracking params. Populated at write time for new rows; legacy
    // duplicates may remain null after migration.
    videoIdentity: text('video_identity'),
    // Boardsesh user who attached this link. Populated by attachBetaLink and
    // by the saveTick beta-link insert path; NULL for legacy rows written
    // before this column existed and for any future write path that didn't
    // route through requireAuthenticated.
    //
    // ⚠️ FK managed manually — there's a foreign key
    //   `board_beta_links_created_by_user_id_fkey`
    //   on this column referencing `users(id) ON DELETE SET NULL`, added in
    //   migration `0093_amused_loners.sql`. It is NOT declared via
    //   `.references()` here because the `boards/` schema avoids
    //   cross-package FKs to `auth/users`. Drizzle-kit's snapshot does not
    //   know about this FK, so the next `drizzle-kit generate` against
    //   this table could emit a migration that drops it. If you change
    //   this column, double-check the generated SQL and preserve the FK.
    createdByUserId: text('created_by_user_id'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.climbUuid, table.link] }),
    // Historical Instagram-only lookup. New duplicate checks use
    // videoIdentityUnique below, but this index is kept for existing read and
    // maintenance paths keyed by the Instagram shortcode.
    shortcodeIdx: index('board_beta_links_shortcode_idx')
      .on(table.boardType, table.shortcode)
      .where(sql`${table.shortcode} IS NOT NULL`),
    // Powers the profile-page "their beta" slider lookup. Partial index
    // because the attribution column is NULL for legacy rows.
    createdByIdx: index('board_beta_links_created_by_idx')
      .on(table.createdByUserId, table.createdAt)
      .where(sql`${table.createdByUserId} IS NOT NULL`),
    videoIdentityUnique: uniqueIndex('board_beta_links_video_identity_unique')
      .on(table.videoIdentity)
      .where(sql`${table.videoIdentity} IS NOT NULL`),
    tickUuidUnique: uniqueIndex('board_beta_links_tick_uuid_unique')
      .on(table.tickUuid)
      .where(sql`${table.tickUuid} IS NOT NULL`),
    boardIdx: index('board_beta_links_board_id_idx')
      .on(table.boardId)
      .where(sql`${table.boardId} IS NOT NULL`),
    // Note: No FK to board_climbs - beta links may arrive before their corresponding climbs during sync
  }),
);

// =============================================================================
// User Data Tables (Phase 4)
// =============================================================================

export const boardUsers = pgTable(
  'board_users',
  {
    boardType: text('board_type').notNull(),
    id: integer().notNull(),
    username: text(),
    createdAt: text('created_at'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.id] }),
  }),
);

export const boardCircuits = pgTable(
  'board_circuits',
  {
    boardType: text('board_type').notNull(),
    uuid: text().notNull(),
    name: text(),
    description: text(),
    color: text(),
    userId: integer('user_id'),
    isPublic: boolean('is_public'),
    createdAt: text('created_at'),
    updatedAt: text('updated_at'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.uuid] }),
    userFk: foreignKey({
      columns: [table.boardType, table.userId],
      foreignColumns: [boardUsers.boardType, boardUsers.id],
      name: 'board_circuits_user_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  }),
);

export const boardCircuitsClimbs = pgTable(
  'board_circuits_climbs',
  {
    boardType: text('board_type').notNull(),
    circuitUuid: text('circuit_uuid').notNull(),
    climbUuid: text('climb_uuid').notNull(),
    position: integer(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.circuitUuid, table.climbUuid] }),
    circuitFk: foreignKey({
      columns: [table.boardType, table.circuitUuid],
      foreignColumns: [boardCircuits.boardType, boardCircuits.uuid],
      name: 'board_circuits_climbs_circuit_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    climbFk: foreignKey({
      columns: [table.climbUuid],
      foreignColumns: [boardClimbs.uuid],
      name: 'board_circuits_climbs_climb_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  }),
);

export const boardWalls = pgTable(
  'board_walls',
  {
    boardType: text('board_type').notNull(),
    uuid: text().notNull(),
    userId: integer('user_id'),
    name: text(),
    productId: integer('product_id'),
    isAdjustable: boolean('is_adjustable'),
    angle: integer(),
    layoutId: integer('layout_id'),
    productSizeId: integer('product_size_id'),
    hsm: integer(),
    serialNumber: text('serial_number'),
    createdAt: text('created_at'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.uuid] }),
    userFk: foreignKey({
      columns: [table.boardType, table.userId],
      foreignColumns: [boardUsers.boardType, boardUsers.id],
      name: 'board_walls_user_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    productFk: foreignKey({
      columns: [table.boardType, table.productId],
      foreignColumns: [boardProducts.boardType, boardProducts.id],
      name: 'board_walls_product_fk',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    layoutFk: foreignKey({
      columns: [table.boardType, table.layoutId],
      foreignColumns: [boardLayouts.boardType, boardLayouts.id],
      name: 'board_walls_layout_fk',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    productSizeFk: foreignKey({
      columns: [table.boardType, table.productSizeId],
      foreignColumns: [boardProductSizes.boardType, boardProductSizes.id],
      name: 'board_walls_product_size_fk',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  }),
);

export const boardTags = pgTable(
  'board_tags',
  {
    boardType: text('board_type').notNull(),
    entityUuid: text('entity_uuid').notNull(),
    userId: integer('user_id').notNull(),
    name: text().notNull(),
    isListed: boolean('is_listed'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.entityUuid, table.userId, table.name] }),
  }),
);

// =============================================================================
// Sync Tables (Phase 5)
// =============================================================================

export const boardUserSyncs = pgTable(
  'board_user_syncs',
  {
    boardType: text('board_type').notNull(),
    userId: integer('user_id').notNull(),
    tableName: text('table_name').notNull(),
    lastSynchronizedAt: text('last_synchronized_at'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.userId, table.tableName] }),
    userFk: foreignKey({
      columns: [table.boardType, table.userId],
      foreignColumns: [boardUsers.boardType, boardUsers.id],
      name: 'board_user_syncs_user_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  }),
);

export const boardSharedSyncs = pgTable(
  'board_shared_syncs',
  {
    boardType: text('board_type').notNull(),
    tableName: text('table_name').notNull(),
    lastSynchronizedAt: text('last_synchronized_at'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.tableName] }),
  }),
);

export const boardKits = pgTable(
  'board_kits',
  {
    boardType: text('board_type').notNull(),
    serialNumber: text('serial_number').notNull(),
    name: text('name'),
    isAutoconnect: boolean('is_autoconnect').notNull(),
    isListed: boolean('is_listed').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.serialNumber] }),
  }),
);

// =============================================================================
// Type Exports
// =============================================================================

export type BoardAttempt = typeof boardAttempts.$inferSelect;
export type NewBoardAttempt = typeof boardAttempts.$inferInsert;

export type BoardDifficultyGrade = typeof boardDifficultyGrades.$inferSelect;
export type NewBoardDifficultyGrade = typeof boardDifficultyGrades.$inferInsert;

export type BoardProduct = typeof boardProducts.$inferSelect;
export type NewBoardProduct = typeof boardProducts.$inferInsert;

export type BoardSet = typeof boardSets.$inferSelect;
export type NewBoardSet = typeof boardSets.$inferInsert;

export type BoardProductSize = typeof boardProductSizes.$inferSelect;
export type NewBoardProductSize = typeof boardProductSizes.$inferInsert;

export type BoardLayout = typeof boardLayouts.$inferSelect;
export type NewBoardLayout = typeof boardLayouts.$inferInsert;

export type BoardHole = typeof boardHoles.$inferSelect;
export type NewBoardHole = typeof boardHoles.$inferInsert;

export type BoardPlacementRole = typeof boardPlacementRoles.$inferSelect;
export type NewBoardPlacementRole = typeof boardPlacementRoles.$inferInsert;

export type BoardLed = typeof boardLeds.$inferSelect;
export type NewBoardLed = typeof boardLeds.$inferInsert;

export type BoardPlacement = typeof boardPlacements.$inferSelect;
export type NewBoardPlacement = typeof boardPlacements.$inferInsert;

export type BoardProductSizeLayoutSet = typeof boardProductSizesLayoutsSets.$inferSelect;
export type NewBoardProductSizeLayoutSet = typeof boardProductSizesLayoutsSets.$inferInsert;

export type BoardClimb = typeof boardClimbs.$inferSelect;
export type NewBoardClimb = typeof boardClimbs.$inferInsert;

export type BoardLayoutAlias = typeof boardLayoutAliases.$inferSelect;
export type NewBoardLayoutAlias = typeof boardLayoutAliases.$inferInsert;

export type BoardClimbStat = typeof boardClimbStats.$inferSelect;
export type NewBoardClimbStat = typeof boardClimbStats.$inferInsert;

export type BoardClimbHold = typeof boardClimbHolds.$inferSelect;
export type NewBoardClimbHold = typeof boardClimbHolds.$inferInsert;

export type BoardClimbStatHistory = typeof boardClimbStatsHistory.$inferSelect;
export type NewBoardClimbStatHistory = typeof boardClimbStatsHistory.$inferInsert;

export type BoardBetaLink = typeof boardBetaLinks.$inferSelect;
export type NewBoardBetaLink = typeof boardBetaLinks.$inferInsert;

export type BoardUser = typeof boardUsers.$inferSelect;
export type NewBoardUser = typeof boardUsers.$inferInsert;

export type BoardCircuit = typeof boardCircuits.$inferSelect;
export type NewBoardCircuit = typeof boardCircuits.$inferInsert;

export type BoardCircuitClimb = typeof boardCircuitsClimbs.$inferSelect;
export type NewBoardCircuitClimb = typeof boardCircuitsClimbs.$inferInsert;

export type BoardWall = typeof boardWalls.$inferSelect;
export type NewBoardWall = typeof boardWalls.$inferInsert;

export type BoardTag = typeof boardTags.$inferSelect;
export type NewBoardTag = typeof boardTags.$inferInsert;

export type BoardUserSync = typeof boardUserSyncs.$inferSelect;
export type NewBoardUserSync = typeof boardUserSyncs.$inferInsert;

export type BoardSharedSync = typeof boardSharedSyncs.$inferSelect;
export type NewBoardSharedSync = typeof boardSharedSyncs.$inferInsert;

export type BoardKit = typeof boardKits.$inferSelect;
export type NewBoardKit = typeof boardKits.$inferInsert;

export type BoardClimbAlias = typeof boardClimbAliases.$inferSelect;
export type NewBoardClimbAlias = typeof boardClimbAliases.$inferInsert;

export type BoardClimbRating = typeof boardClimbRatings.$inferSelect;
export type NewBoardClimbRating = typeof boardClimbRatings.$inferInsert;
