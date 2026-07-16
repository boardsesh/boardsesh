# Database Consolidation Migration Plan

## Executive Summary

### Current State

Boardsesh currently maintains **36 board-specific Aurora tables** (18 for Kilter, 18 for Tension) with identical schemas but separate data. This pattern was inherited from Aurora's API structure but creates maintenance overhead and prevents unified queries across board types.

### Target State

Consolidate into **18 unified tables** with a `board_type` discriminator column. This pattern is already proven successful with the `boardsesh_ticks` table which consolidated ascents/bids logging.

### Approach

- **Phased migration** ordered by table dependencies
- **Full deprecation** of Aurora board-specific tables (not dual-write)
- **MoonBoard support** included in unified schema design

---

## Current Tables (18 per board type)

| Category                          | Tables                                                                                                                         | Description                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| **Reference/Lookup**              | `attempts`, `difficulty_grades`                                                                                                | Static lookup data                       |
| **Product Configuration**         | `products`, `product_sizes`, `layouts`, `holes`, `leds`, `placements`, `placement_roles`, `sets`, `product_sizes_layouts_sets` | Board hardware definitions               |
| **Core Climb Data**               | `climbs`, `climb_stats`, `climb_holds`, `climb_stats_history`, `beta_links`                                                    | Climb problem definitions and statistics |
| **User Data**                     | `users`, `walls`, `circuits`, `circuits_climbs`, `tags`                                                                        | User-specific data                       |
| **Sync Tracking**                 | `user_syncs`, `shared_syncs`                                                                                                   | Aurora sync state                        |
| **Legacy (already consolidated)** | `ascents`, `bids`                                                                                                              | Now in `boardsesh_ticks`                 |

---

## Migration Phases

### Phase 0: Preparation

**Duration**: 1 day
**Risk**: Low
**Dependencies**: None

#### Objectives

- Create unified schema file
- Set up feature flags for gradual rollout
- Establish migration infrastructure

#### Tasks

1. Create `packages/db/src/schema/boards/unified.ts`
2. Add `board_type` type definition (text field, not enum for flexibility)
3. Set up environment variable `USE_UNIFIED_TABLES=false`

#### Acceptance Criteria

- [x] Unified schema file exists with board_type type
- [x] Feature flag infrastructure in place
- [x] No changes to runtime behavior

---

## Implementation Status Summary

| Component                      | Status      | Notes                                                                   |
| ------------------------------ | ----------- | ----------------------------------------------------------------------- |
| Phase 0: Preparation           | ✅ Complete | unified.ts schema created                                               |
| Phase 1-5: Migrations          | ✅ Complete | All 22 tables created, data migrated                                    |
| Task 4: table-select.ts        | ✅ Complete | UNIFIED_TABLES, getUnifiedTable(), boardTypeCondition()                 |
| Task 5: Sync Functions         | ✅ Complete | shared-sync.ts and user-sync.ts updated                                 |
| Task 6: Query Files            | ✅ Complete | All query files updated to use unified tables                           |
| Phase 6: Ascents/Bids Cleanup  | ✅ Complete | Switched to boardsesh_ticks with NextAuth userId, legacy tables dropped |
| Task 7: MoonBoard Storage      | 📋 Planned  | Server-side storage for MoonBoard climbs                                |
| Phase 6b: Legacy Table Cleanup | 📋 Planned  | Drop remaining legacy board-specific tables                             |

### Phase 6 Key Decisions

**Ascents/Bids Migration to boardsesh_ticks:**

- All ascent and bid data now uses `boardsesh_ticks` table exclusively
- Uses NextAuth `userId` (string) instead of Aurora `user_id` (integer)
- Data not associated with NextAuth userId was accepted as droppable
- Legacy tables (`kilter_ascents`, `kilter_bids`, `tension_ascents`, `tension_bids`) dropped via migration `0030_drop_legacy_ascents_bids.sql`
- Removed `migrate-user-history.ts` and `/api/internal/migrate-users-cron` route (no longer needed)

---

### Phase 1: Reference Tables

**Duration**: 1-2 days
**Risk**: Low
**Dependencies**: Phase 0

#### Tables

- `board_attempts`
- `board_difficulty_grades`

#### Schema Design

```typescript
// packages/db/src/schema/boards/unified.ts

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
```

#### Migration SQL

```sql
-- Migration: 00XX_consolidate_reference_tables.sql

-- Create unified attempts table
CREATE TABLE board_attempts (
  board_type text NOT NULL,
  id integer NOT NULL,
  position integer,
  name text,
  PRIMARY KEY (board_type, id)
);

-- Migrate kilter data
INSERT INTO board_attempts (board_type, id, position, name)
SELECT 'kilter', id, position, name FROM kilter_attempts;

-- Migrate tension data
INSERT INTO board_attempts (board_type, id, position, name)
SELECT 'tension', id, position, name FROM tension_attempts;

-- MoonBoard attempts (placeholder - adjust based on MoonBoard grading)
INSERT INTO board_attempts (board_type, id, position, name) VALUES
  ('moonboard', 1, 1, 'Flash'),
  ('moonboard', 2, 2, 'Send');

-- Create unified difficulty grades table
CREATE TABLE board_difficulty_grades (
  board_type text NOT NULL,
  difficulty integer NOT NULL,
  boulder_name text,
  route_name text,
  is_listed boolean,
  PRIMARY KEY (board_type, difficulty)
);

-- Migrate kilter data
INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, route_name, is_listed)
SELECT 'kilter', difficulty, boulder_name, route_name, is_listed FROM kilter_difficulty_grades;

-- Migrate tension data
INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, route_name, is_listed)
SELECT 'tension', difficulty, boulder_name, route_name, is_listed FROM tension_difficulty_grades;

-- MoonBoard grades (Font scale)
INSERT INTO board_difficulty_grades (board_type, difficulty, boulder_name, is_listed) VALUES
  ('moonboard', 10, '6A', true),
  ('moonboard', 11, '6A+', true),
  ('moonboard', 12, '6B', true),
  ('moonboard', 13, '6B+', true),
  ('moonboard', 14, '6C', true),
  ('moonboard', 15, '6C+', true),
  ('moonboard', 16, '7A', true),
  ('moonboard', 17, '7A+', true),
  ('moonboard', 18, '7B', true),
  ('moonboard', 19, '7B+', true),
  ('moonboard', 20, '7C', true),
  ('moonboard', 21, '7C+', true),
  ('moonboard', 22, '8A', true),
  ('moonboard', 23, '8A+', true),
  ('moonboard', 24, '8B', true),
  ('moonboard', 25, '8B+', true);
```

#### Acceptance Criteria

- [x] Both tables created with composite primary keys
- [x] All kilter and tension data migrated
- [x] MoonBoard reference data seeded
- [x] Indexes created

**Status**: ✅ Completed in migration `0025_shocking_clint_barton.sql`

---

### Phase 2: Product Configuration Tables

**Duration**: 3-5 days
**Risk**: Medium
**Dependencies**: Phase 1

#### Tables (in dependency order)

1. `board_products`
2. `board_sets`
3. `board_product_sizes`
4. `board_layouts`
5. `board_holes`
6. `board_placement_roles`
7. `board_leds`
8. `board_placements`
9. `board_product_sizes_layouts_sets`

#### Schema Design

```typescript
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
```

#### MoonBoard Product Data

MoonBoard reference data is derived from `MOONBOARD_LAYOUTS`,
`MOONBOARD_SETS`, and the generated `MOONBOARD_CELL_SETS` map in
`@boardsesh/board-config`. Run `vp run db:backfill-moonboard-hardware` for a
read-only report, then pass `-- --apply` to insert missing exact rows.

The backfill creates one shared 11 by 18 hole grid (`A1` through `K18`) and one
placement for every covered layout/cell pair. MoonBoard frame IDs are shared
cell IDs, so placements use the stable synthetic ID
`layout_id * 1000 + cell_id`, retain `hole_id = cell_id`, and carry the real
layout and hold-set IDs. The command is transactional and refuses conflicting
existing MoonBoard reference rows.

#### Acceptance Criteria

- [x] All 9 tables created with proper foreign keys
- [x] All kilter and tension data migrated
- [x] MoonBoard product/layout/set data has a repeatable backfill
- [x] MoonBoard holes and layout-specific placements have a repeatable backfill
- [x] Foreign key constraints validated

**Status**: ✅ Tables created and kilter/tension data migrated in `0025_shocking_clint_barton.sql`

---

### Phase 3: Core Climb Tables

**Duration**: 5-7 days
**Risk**: High
**Dependencies**: Phase 2

#### Tables

1. `board_climbs`
2. `board_climb_stats`
3. `board_climb_holds`
4. `board_climb_stats_history`
5. `board_beta_links`

#### Schema Design

```typescript
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
    synced: boolean('synced').default(true).notNull(),
    syncError: text('sync_error'),
  },
  (table) => ({
    boardTypeIdx: index('board_climbs_board_type_idx').on(table.boardType),
    layoutFilterIdx: index('board_climbs_layout_filter_idx').on(
      table.boardType,
      table.layoutId,
      table.isListed,
      table.isDraft,
      table.framesCount,
    ),
    edgesIdx: index('board_climbs_edges_idx').on(
      table.boardType,
      table.edgeLeft,
      table.edgeRight,
      table.edgeBottom,
      table.edgeTop,
    ),
    layoutFk: foreignKey({
      columns: [table.boardType, table.layoutId],
      foreignColumns: [boardLayouts.boardType, boardLayouts.id],
      name: 'board_climbs_layout_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
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
    ascensionistCount: bigint('ascensionist_count', { mode: 'number' }),
    difficultyAverage: doublePrecision('difficulty_average'),
    qualityAverage: doublePrecision('quality_average'),
    faUsername: text('fa_username'),
    faAt: timestamp('fa_at', { mode: 'string' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.climbUuid, table.angle] }),
    climbFk: foreignKey({
      columns: [table.climbUuid],
      foreignColumns: [boardClimbs.uuid],
      name: 'board_climb_stats_climb_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
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
  },
  (table) => ({
    pk: primaryKey({ columns: [table.boardType, table.climbUuid, table.link] }),
    climbFk: foreignKey({
      columns: [table.climbUuid],
      foreignColumns: [boardClimbs.uuid],
      name: 'board_beta_links_climb_fk',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  }),
);
```

#### Migration Notes

- `board_climbs` uses UUID primary key (no composite needed)
- All related tables include `board_type` in composite keys
- MoonBoard climbs will be migrated from IndexedDB (separate task)

#### Acceptance Criteria

- [x] All 5 tables created with proper keys/indexes
- [x] All kilter and tension climb data migrated
- [x] Foreign keys to layouts validated
- [x] Climb statistics preserved accurately

**Status**: ✅ Completed in migration `0025_shocking_clint_barton.sql`

---

### Phase 4: User Data Tables

**Duration**: 5-7 days
**Risk**: High
**Dependencies**: Phase 3

#### Tables

1. `board_users` (Aurora users, distinct from NextAuth users)
2. `board_circuits`
3. `board_circuits_climbs`
4. `board_walls`
5. `board_tags`

#### Schema Design

```typescript
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
```

#### Note on Legacy Ascents/Bids

The `kilter_ascents`, `kilter_bids`, `tension_ascents`, `tension_bids` tables are already consolidated into `boardsesh_ticks`. These legacy tables should be dropped in Phase 6 after validating data integrity.

#### Acceptance Criteria

- [x] All 5 tables created
- [x] All kilter and tension user data migrated
- [x] Circuit-climb relationships preserved
- [x] Wall configurations intact

**Status**: ✅ Completed in migration `0025_shocking_clint_barton.sql`

---

### Phase 5: Sync Tables

**Duration**: 2-3 days
**Risk**: Medium
**Dependencies**: Phase 4

#### Tables

1. `board_user_syncs`
2. `board_shared_syncs`

#### Schema Design

```typescript
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
```

#### Acceptance Criteria

- [x] Sync tables created
- [x] Sync state migrated
- [x] Aurora sync continues working (Task 5 complete)

**Status**: ✅ Tables created and data migrated in `0025_shocking_clint_barton.sql`

---

### Phase 6: Cleanup

**Duration**: 1-2 weeks (with monitoring)
**Risk**: Low (if previous phases validated)
**Dependencies**: All previous phases + monitoring period

#### Tasks

1. Remove feature flag checks
2. Update all queries to use unified tables only
3. Drop legacy board-specific tables
4. Remove dual-write code paths
5. Clean up old schema files

#### Drop Order (reverse of creation)

```sql
-- Phase 6a: Drop user data tables
DROP TABLE IF EXISTS kilter_tags, tension_tags;
DROP TABLE IF EXISTS kilter_circuits_climbs, tension_circuits_climbs;
DROP TABLE IF EXISTS kilter_circuits, tension_circuits;
DROP TABLE IF EXISTS kilter_walls, tension_walls;
DROP TABLE IF EXISTS kilter_user_syncs, tension_user_syncs;
DROP TABLE IF EXISTS kilter_shared_syncs, tension_shared_syncs;

-- Phase 6b: Drop climb tables
DROP TABLE IF EXISTS kilter_beta_links, tension_beta_links;
DROP TABLE IF EXISTS kilter_climb_stats_history, tension_climb_stats_history;
DROP TABLE IF EXISTS kilter_climb_holds, tension_climb_holds;
DROP TABLE IF EXISTS kilter_climb_stats, tension_climb_stats;
DROP TABLE IF EXISTS kilter_climbs, tension_climbs;

-- Phase 6c: Drop product config tables
DROP TABLE IF EXISTS kilter_product_sizes_layouts_sets, tension_product_sizes_layouts_sets;
DROP TABLE IF EXISTS kilter_placements, tension_placements;
DROP TABLE IF EXISTS kilter_leds, tension_leds;
DROP TABLE IF EXISTS kilter_placement_roles, tension_placement_roles;
DROP TABLE IF EXISTS kilter_holes, tension_holes;
DROP TABLE IF EXISTS kilter_layouts, tension_layouts;
DROP TABLE IF EXISTS kilter_product_sizes, tension_product_sizes;
DROP TABLE IF EXISTS kilter_sets, tension_sets;
DROP TABLE IF EXISTS kilter_products, tension_products;

-- Phase 6d: Drop reference tables
DROP TABLE IF EXISTS kilter_difficulty_grades, tension_difficulty_grades;
DROP TABLE IF EXISTS kilter_attempts, tension_attempts;

-- Phase 6e: Drop legacy ascent tables (already consolidated to boardsesh_ticks)
DROP TABLE IF EXISTS kilter_ascents, tension_ascents;
DROP TABLE IF EXISTS kilter_bids, tension_bids;
DROP TABLE IF EXISTS kilter_users, tension_users;
```

#### Acceptance Criteria

- [ ] All legacy tables dropped
- [ ] Application using unified tables only
- [ ] No errors in production for 1 week
- [ ] Database size reduced

---

## Application Layer Changes

### 1. Update table-select.ts

**File**: `packages/web/app/lib/db/queries/util/table-select.ts`

```typescript
import { BoardName } from '@/app/lib/api-wrappers/aurora/types';
import * as unified from '@/lib/db/schema/boards/unified';

// New unified table set
export const UNIFIED_TABLES = {
  climbs: unified.boardClimbs,
  climbStats: unified.boardClimbStats,
  climbHolds: unified.boardClimbHolds,
  climbStatsHistory: unified.boardClimbStatsHistory,
  betaLinks: unified.boardBetaLinks,
  difficultyGrades: unified.boardDifficultyGrades,
  productSizes: unified.boardProductSizes,
  layouts: unified.boardLayouts,
  products: unified.boardProducts,
  holes: unified.boardHoles,
  leds: unified.boardLeds,
  placements: unified.boardPlacements,
  placementRoles: unified.boardPlacementRoles,
  sets: unified.boardSets,
  productSizesLayoutsSets: unified.boardProductSizesLayoutsSets,
  users: unified.boardUsers,
  circuits: unified.boardCircuits,
  circuitsClimbs: unified.boardCircuitsClimbs,
  walls: unified.boardWalls,
  tags: unified.boardTags,
  userSyncs: unified.boardUserSyncs,
  sharedSyncs: unified.boardSharedSyncs,
  attempts: unified.boardAttempts,
} as const;

export type UnifiedTableSet = typeof UNIFIED_TABLES;

/**
 * Get a unified table (all queries should filter by board_type)
 */
export function getUnifiedTable<K extends keyof UnifiedTableSet>(tableName: K): UnifiedTableSet[K] {
  return UNIFIED_TABLES[tableName];
}

/**
 * Helper to create board_type condition for WHERE clauses
 */
export function boardTypeCondition<T extends { boardType: unknown }>(table: T, boardName: BoardName) {
  return eq(table.boardType, boardName);
}
```

### 2. Update Sync Functions

**Files**:

- `packages/web/app/lib/data-sync/aurora/shared-sync.ts`
- `packages/web/app/lib/data-sync/aurora/user-sync.ts`

Add `boardType` to all INSERT/UPDATE operations:

```typescript
// Before (current pattern)
await db.insert(climbsSchema).values({
  uuid: item.uuid,
  layoutId: item.layout_id,
  // ...
});

// After (unified pattern)
await db.insert(boardClimbs).values({
  boardType: boardName,
  uuid: item.uuid,
  layoutId: item.layout_id,
  // ...
});
```

### 3. Update Query Filters

**File**: `packages/web/app/lib/db/queries/climbs/create-climb-filters.ts`

Add `board_type` to base conditions:

```typescript
// Add to base conditions array
baseConditions.push(eq(boardClimbs.boardType, boardName));
```

### 4. Update Raw SQL Queries

**File**: `packages/web/app/lib/data/queries.ts`

Replace dynamic table names with parameterized board_type:

```typescript
// Before
const tableName = `${boardName}_climbs`;
sql`SELECT * FROM ${sql.identifier(tableName)} WHERE ...`;

// After
sql`SELECT * FROM board_climbs WHERE board_type = ${boardName} AND ...`;
```

---

## Agent Task Breakdown

Each task is designed to be independently implementable by an AI agent.

### Task 1: Schema Design

**Scope**: Create unified schema definitions

**Files to create**:

- `packages/db/src/schema/boards/unified.ts`

**Steps**:

1. Define all 22 unified tables with Drizzle ORM
2. Create composite primary keys with `board_type`
3. Define foreign key relationships
4. Export type definitions

**Acceptance Criteria**:

- All tables defined with proper TypeScript types
- Foreign keys reference correct unified tables
- Compatible with existing Drizzle patterns

---

### Task 2: Phase 1-2 Migrations

**Scope**: Reference and product configuration tables

**Files to create**:

- `packages/db/drizzle/00XX_consolidate_reference_tables.sql`
- `packages/db/drizzle/00XX_consolidate_product_tables.sql`

**Steps**:

1. Generate CREATE TABLE statements
2. Write INSERT...SELECT migration queries
3. Add MoonBoard seed data
4. Create indexes

**Acceptance Criteria**:

- Tables created successfully
- All existing data migrated
- MoonBoard data seeded
- Indexes created

---

### Task 3: Phase 3-4 Migrations

**Scope**: Climb and user data tables

**Files to create**:

- `packages/db/drizzle/00XX_consolidate_climb_tables.sql`
- `packages/db/drizzle/00XX_consolidate_user_tables.sql`

**Steps**:

1. Generate CREATE TABLE statements
2. Write INSERT...SELECT migration queries
3. Handle UUID primary keys appropriately
4. Create indexes

**Acceptance Criteria**:

- Tables created successfully
- All climb data migrated with correct board_type
- User relationships preserved

---

### Task 4: table-select.ts Update

**Scope**: Update abstraction layer

**Files to modify**:

- `packages/web/app/lib/db/queries/util/table-select.ts`

**Steps**:

1. Add unified table imports
2. Create `UNIFIED_TABLES` constant
3. Add `getUnifiedTable()` function
4. Add `boardTypeCondition()` helper
5. Keep backward compatibility during migration

**Acceptance Criteria**:

- New functions exported
- Type safety maintained
- Backward compatible with existing code

---

### Task 5: Sync Function Updates

**Scope**: Aurora sync with unified tables

**Files to modify**:

- `packages/web/app/lib/data-sync/aurora/shared-sync.ts`
- `packages/web/app/lib/data-sync/aurora/user-sync.ts`
- `packages/web/app/lib/data-sync/aurora/getTableName.ts`

**Steps**:

1. Update imports to use unified tables
2. Add `boardType` to all INSERT operations
3. Update conflict resolution to include `board_type`
4. Test sync with both kilter and tension

**Acceptance Criteria**:

- Sync works with unified tables
- No data loss during sync
- Conflict resolution handles board_type

---

### Task 6: Query Updates

**Scope**: Update all raw SQL and filter queries

**Files to modify**:

- `packages/web/app/lib/db/queries/climbs/create-climb-filters.ts`
- `packages/web/app/lib/db/queries/climbs/holds-heatmap.ts`
- `packages/web/app/lib/db/queries/climbs/setter-stats.ts`
- `packages/web/app/lib/data/queries.ts`

**Steps**:

1. Replace `getTableName()` with unified table references
2. Add `board_type` conditions to WHERE clauses
3. Update JOIN conditions
4. Test all query paths

**Acceptance Criteria**:

- All queries use unified tables
- Board type filtering works correctly
- Query performance maintained

---

### Task 7: MoonBoard Server Storage

**Scope**: Migrate MoonBoard from IndexedDB to PostgreSQL

**Files to modify**:

- `packages/web/app/lib/moonboard-climbs-db.ts` (refactor or deprecate)
- New: `packages/web/app/lib/moonboard-server-storage.ts`

**Steps**:

1. Create server-side MoonBoard climb storage
2. Convert IndexedDB schema to PostgreSQL schema
3. Create migration path from IndexedDB to server
4. Update MoonBoard UI to use server storage

**Acceptance Criteria**:

- MoonBoard climbs stored in `board_climbs`
- Existing IndexedDB data can be migrated
- OCR import works with server storage

---

### Task 8: Cleanup and Deprecation

**Scope**: Remove old tables and code

**Files to modify**:

- `packages/db/src/schema/boards/kilter.ts` (delete)
- `packages/db/src/schema/boards/tension.ts` (delete)
- `packages/db/src/schema/index.ts` (update exports)
- Various query files (remove legacy references)

**Steps**:

1. Create DROP TABLE migration
2. Remove old schema files
3. Update all imports
4. Clean up dead code

**Acceptance Criteria**:

- Old tables dropped
- No references to old schemas
- Application fully on unified tables

---

## Rollback Strategy

### During Migration (Phases 1-5)

- Old tables remain intact
- Feature flag allows switching back
- Dual-read possible if needed

### After Cleanup (Phase 6)

- Backup taken before DROP statements
- Point-in-time recovery available
- Rollback requires restoring from backup

---

## Testing Strategy

### Unit Tests

- Schema type compatibility
- Migration SQL syntax validation
- Query builder output verification

### Integration Tests

- Sync functionality end-to-end
- CRUD operations on unified tables
- Foreign key constraint validation

### Data Validation

- Row counts match between old and new
- Checksums on critical data
- Sample queries produce same results

---

## Timeline Estimate

| Phase      | Duration | Cumulative |
| ---------- | -------- | ---------- |
| Phase 0    | 1 day    | 1 day      |
| Phase 1    | 2 days   | 3 days     |
| Phase 2    | 5 days   | 8 days     |
| Phase 3    | 7 days   | 15 days    |
| Phase 4    | 7 days   | 22 days    |
| Phase 5    | 3 days   | 25 days    |
| Monitoring | 7 days   | 32 days    |
| Phase 6    | 3 days   | 35 days    |

**Total**: ~5-7 weeks with monitoring period

---

## Files Reference

### Schema Files

- `packages/db/src/schema/boards/kilter.ts` - Current kilter schema (reference)
- `packages/db/src/schema/boards/tension.ts` - Current tension schema (reference)
- `packages/db/src/schema/app/ascents.ts` - Consolidated pattern (boardsesh_ticks)
- `packages/db/src/schema/boards/unified.ts` - NEW: Unified schemas

### Query Files

- `packages/web/app/lib/db/queries/util/table-select.ts` - Table abstraction
- `packages/web/app/lib/db/queries/climbs/create-climb-filters.ts` - SQL filters
- `packages/web/app/lib/db/queries/climbs/holds-heatmap.ts` - Hold stats
- `packages/web/app/lib/db/queries/climbs/setter-stats.ts` - Setter stats

### Sync Files

- `packages/web/app/lib/data-sync/aurora/shared-sync.ts` - Shared data sync
- `packages/web/app/lib/data-sync/aurora/user-sync.ts` - User data sync
- `packages/web/app/lib/data-sync/aurora/getTableName.ts` - Table name helper

### MoonBoard Files

- `packages/web/app/lib/moonboard-config.ts` - MoonBoard configuration
- `packages/web/app/lib/moonboard-climbs-db.ts` - IndexedDB storage
