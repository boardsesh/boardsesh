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
} from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

// =============================================================================
// Reference Tables (Phase 1)
// =============================================================================

export const boardAttempts = pgTable('board_attempts', {
  boardType: text('board_type').notNull(),
  id: integer().notNull(),
  position: integer(),
  name: text(),
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.id] }),
}));

export const boardDifficultyGrades = pgTable('board_difficulty_grades', {
  boardType: text('board_type').notNull(),
  difficulty: integer().notNull(),
  boulderName: text('boulder_name'),
  routeName: text('route_name'),
  isListed: boolean('is_listed'),
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.difficulty] }),
}));

// =============================================================================
// Product Configuration Tables (Phase 2)
// =============================================================================

export const boardProducts = pgTable('board_products', {
  boardType: text('board_type').notNull(),
  id: integer().notNull(),
  name: text(),
  isListed: boolean('is_listed'),
  password: text(),
  minCountInFrame: integer('min_count_in_frame'),
  maxCountInFrame: integer('max_count_in_frame'),
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.id] }),
}));

export const boardSets = pgTable('board_sets', {
  boardType: text('board_type').notNull(),
  id: integer().notNull(),
  name: text(),
  hsm: integer(),
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.id] }),
}));

export const boardProductSizes = pgTable('board_product_sizes', {
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
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.id] }),
  productFk: foreignKey({
    columns: [table.boardType, table.productId],
    foreignColumns: [boardProducts.boardType, boardProducts.id],
    name: 'board_product_sizes_product_fk',
  }).onUpdate('cascade').onDelete('cascade'),
}));

export const boardLayouts = pgTable('board_layouts', {
  boardType: text('board_type').notNull(),
  id: integer().notNull(),
  productId: integer('product_id'),
  name: text(),
  instagramCaption: text('instagram_caption'),
  isMirrored: boolean('is_mirrored'),
  isListed: boolean('is_listed'),
  password: text(),
  createdAt: text('created_at'),
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.id] }),
  productFk: foreignKey({
    columns: [table.boardType, table.productId],
    foreignColumns: [boardProducts.boardType, boardProducts.id],
    name: 'board_layouts_product_fk',
  }).onUpdate('cascade').onDelete('cascade'),
}));

export const boardHoles = pgTable('board_holes', {
  boardType: text('board_type').notNull(),
  id: integer().notNull(),
  productId: integer('product_id'),
  name: text(),
  x: integer(),
  y: integer(),
  mirroredHoleId: integer('mirrored_hole_id'),
  mirrorGroup: integer('mirror_group').default(0),
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.id] }),
  productFk: foreignKey({
    columns: [table.boardType, table.productId],
    foreignColumns: [boardProducts.boardType, boardProducts.id],
    name: 'board_holes_product_fk',
  }).onUpdate('cascade').onDelete('cascade'),
}));

export const boardPlacementRoles = pgTable('board_placement_roles', {
  boardType: text('board_type').notNull(),
  id: integer().notNull(),
  productId: integer('product_id'),
  position: integer(),
  name: text(),
  fullName: text('full_name'),
  ledColor: text('led_color'),
  screenColor: text('screen_color'),
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.id] }),
  productFk: foreignKey({
    columns: [table.boardType, table.productId],
    foreignColumns: [boardProducts.boardType, boardProducts.id],
    name: 'board_placement_roles_product_fk',
  }).onUpdate('cascade').onDelete('cascade'),
}));

export const boardLeds = pgTable('board_leds', {
  boardType: text('board_type').notNull(),
  id: integer().notNull(),
  productSizeId: integer('product_size_id'),
  holeId: integer('hole_id'),
  position: integer(),
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.id] }),
  productSizeFk: foreignKey({
    columns: [table.boardType, table.productSizeId],
    foreignColumns: [boardProductSizes.boardType, boardProductSizes.id],
    name: 'board_leds_product_size_fk',
  }).onUpdate('cascade').onDelete('cascade'),
  holeFk: foreignKey({
    columns: [table.boardType, table.holeId],
    foreignColumns: [boardHoles.boardType, boardHoles.id],
    name: 'board_leds_hole_fk',
  }).onUpdate('cascade').onDelete('cascade'),
}));

export const boardPlacements = pgTable('board_placements', {
  boardType: text('board_type').notNull(),
  id: integer().notNull(),
  layoutId: integer('layout_id'),
  holeId: integer('hole_id'),
  setId: integer('set_id'),
  defaultPlacementRoleId: integer('default_placement_role_id'),
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.id] }),
  layoutFk: foreignKey({
    columns: [table.boardType, table.layoutId],
    foreignColumns: [boardLayouts.boardType, boardLayouts.id],
    name: 'board_placements_layout_fk',
  }).onUpdate('cascade').onDelete('cascade'),
  holeFk: foreignKey({
    columns: [table.boardType, table.holeId],
    foreignColumns: [boardHoles.boardType, boardHoles.id],
    name: 'board_placements_hole_fk',
  }).onUpdate('cascade').onDelete('cascade'),
  setFk: foreignKey({
    columns: [table.boardType, table.setId],
    foreignColumns: [boardSets.boardType, boardSets.id],
    name: 'board_placements_set_fk',
  }).onUpdate('cascade').onDelete('cascade'),
  roleFk: foreignKey({
    columns: [table.boardType, table.defaultPlacementRoleId],
    foreignColumns: [boardPlacementRoles.boardType, boardPlacementRoles.id],
    name: 'board_placements_role_fk',
  }).onUpdate('cascade').onDelete('restrict'),
}));

export const boardProductSizesLayoutsSets = pgTable('board_product_sizes_layouts_sets', {
  boardType: text('board_type').notNull(),
  id: integer().notNull(),
  productSizeId: integer('product_size_id'),
  layoutId: integer('layout_id'),
  setId: integer('set_id'),
  imageFilename: text('image_filename'),
  isListed: boolean('is_listed'),
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.id] }),
  productSizeFk: foreignKey({
    columns: [table.boardType, table.productSizeId],
    foreignColumns: [boardProductSizes.boardType, boardProductSizes.id],
    name: 'board_psls_product_size_fk',
  }).onUpdate('cascade').onDelete('cascade'),
  layoutFk: foreignKey({
    columns: [table.boardType, table.layoutId],
    foreignColumns: [boardLayouts.boardType, boardLayouts.id],
    name: 'board_psls_layout_fk',
  }).onUpdate('cascade').onDelete('cascade'),
  setFk: foreignKey({
    columns: [table.boardType, table.setId],
    foreignColumns: [boardSets.boardType, boardSets.id],
    name: 'board_psls_set_fk',
  }).onUpdate('cascade').onDelete('cascade'),
}));

// =============================================================================
// Core Climb Tables (Phase 3)
// =============================================================================

export const boardClimbs = pgTable('board_climbs', {
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
}, (table) => ({
  boardTypeIdx: index('board_climbs_board_type_idx').on(table.boardType),
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
  setterUsernameIdx: index('board_climbs_setter_username_idx').on(
    table.boardType,
    table.setterUsername,
  ),
  // Index for climb name lookups (used by JSON import to resolve names to UUIDs)
  nameIdx: index('board_climbs_name_idx').on(
    table.boardType,
    table.name,
  ),
  // Note: No FK to board_layouts - climbs may reference layouts that don't exist during sync
}));

export const boardClimbStats = pgTable('board_climb_stats', {
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
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.climbUuid, table.angle] }),
  // Note: board_climb_stats_ascents_covering_idx is created in custom migration 0067
  // with DESC NULLS LAST and INCLUDE columns that Drizzle can't express.
  // Do NOT add an ascents index here — it would conflict with the custom migration.
  // Note: No FK to board_climbs - stats may arrive before their corresponding climbs during sync
}));

export const boardClimbHolds = pgTable('board_climb_holds', {
  boardType: text('board_type').notNull(),
  climbUuid: text('climb_uuid').notNull(),
  holdId: integer('hold_id').notNull(),
  frameNumber: integer('frame_number').notNull(),
  holdState: text('hold_state').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.climbUuid, table.holdId] }),
  holdSearchIdx: index('board_climb_holds_search_idx').on(
    table.boardType,
    table.holdId,
    table.holdState,
  ),
  climbFk: foreignKey({
    columns: [table.climbUuid],
    foreignColumns: [boardClimbs.uuid],
    name: 'board_climb_holds_climb_fk',
  }).onUpdate('cascade').onDelete('cascade'),
}));

export const boardClimbStatsHistory = pgTable('board_climb_stats_history', {
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
}, (table) => ({
  boardTypeClimbIdx: index('board_climb_stats_history_lookup_idx').on(
    table.boardType,
    table.climbUuid,
    table.angle,
  ),
}));

export const boardBetaLinks = pgTable('board_beta_links', {
  boardType: text('board_type').notNull(),
  climbUuid: text('climb_uuid').notNull(),
  link: text().notNull(),
  foreignUsername: text('foreign_username'),
  angle: integer(),
  thumbnail: text(),
  isListed: boolean('is_listed'),
  createdAt: text('created_at'),
  // Accessibility check state. null = never checked (render optimistically),
  // true = last check passed (render), false = last check failed (hide).
  // See checkInstagramAccessibility for detection logic.
  isAccessible: boolean('is_accessible'),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.climbUuid, table.link] }),
  // Note: No FK to board_climbs - beta links may arrive before their corresponding climbs during sync
}));

// =============================================================================
// User Data Tables (Phase 4)
// =============================================================================

export const boardUsers = pgTable('board_users', {
  boardType: text('board_type').notNull(),
  id: integer().notNull(),
  username: text(),
  createdAt: text('created_at'),
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.id] }),
}));

export const boardCircuits = pgTable('board_circuits', {
  boardType: text('board_type').notNull(),
  uuid: text().notNull(),
  name: text(),
  description: text(),
  color: text(),
  userId: integer('user_id'),
  isPublic: boolean('is_public'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.uuid] }),
  userFk: foreignKey({
    columns: [table.boardType, table.userId],
    foreignColumns: [boardUsers.boardType, boardUsers.id],
    name: 'board_circuits_user_fk',
  }).onUpdate('cascade').onDelete('cascade'),
}));

export const boardCircuitsClimbs = pgTable('board_circuits_climbs', {
  boardType: text('board_type').notNull(),
  circuitUuid: text('circuit_uuid').notNull(),
  climbUuid: text('climb_uuid').notNull(),
  position: integer(),
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.circuitUuid, table.climbUuid] }),
  circuitFk: foreignKey({
    columns: [table.boardType, table.circuitUuid],
    foreignColumns: [boardCircuits.boardType, boardCircuits.uuid],
    name: 'board_circuits_climbs_circuit_fk',
  }).onUpdate('cascade').onDelete('cascade'),
  climbFk: foreignKey({
    columns: [table.climbUuid],
    foreignColumns: [boardClimbs.uuid],
    name: 'board_circuits_climbs_climb_fk',
  }).onUpdate('cascade').onDelete('cascade'),
}));

export const boardWalls = pgTable('board_walls', {
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
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.uuid] }),
  userFk: foreignKey({
    columns: [table.boardType, table.userId],
    foreignColumns: [boardUsers.boardType, boardUsers.id],
    name: 'board_walls_user_fk',
  }).onUpdate('cascade').onDelete('cascade'),
  productFk: foreignKey({
    columns: [table.boardType, table.productId],
    foreignColumns: [boardProducts.boardType, boardProducts.id],
    name: 'board_walls_product_fk',
  }).onUpdate('cascade').onDelete('restrict'),
  layoutFk: foreignKey({
    columns: [table.boardType, table.layoutId],
    foreignColumns: [boardLayouts.boardType, boardLayouts.id],
    name: 'board_walls_layout_fk',
  }).onUpdate('cascade').onDelete('restrict'),
  productSizeFk: foreignKey({
    columns: [table.boardType, table.productSizeId],
    foreignColumns: [boardProductSizes.boardType, boardProductSizes.id],
    name: 'board_walls_product_size_fk',
  }).onUpdate('cascade').onDelete('restrict'),
}));

export const boardTags = pgTable('board_tags', {
  boardType: text('board_type').notNull(),
  entityUuid: text('entity_uuid').notNull(),
  userId: integer('user_id').notNull(),
  name: text().notNull(),
  isListed: boolean('is_listed'),
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.entityUuid, table.userId, table.name] }),
}));

// =============================================================================
// Sync Tables (Phase 5)
// =============================================================================

export const boardUserSyncs = pgTable('board_user_syncs', {
  boardType: text('board_type').notNull(),
  userId: integer('user_id').notNull(),
  tableName: text('table_name').notNull(),
  lastSynchronizedAt: text('last_synchronized_at'),
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.userId, table.tableName] }),
  userFk: foreignKey({
    columns: [table.boardType, table.userId],
    foreignColumns: [boardUsers.boardType, boardUsers.id],
    name: 'board_user_syncs_user_fk',
  }).onUpdate('cascade').onDelete('cascade'),
}));

export const boardSharedSyncs = pgTable('board_shared_syncs', {
  boardType: text('board_type').notNull(),
  tableName: text('table_name').notNull(),
  lastSynchronizedAt: text('last_synchronized_at'),
}, (table) => ({
  pk: primaryKey({ columns: [table.boardType, table.tableName] }),
}));

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
