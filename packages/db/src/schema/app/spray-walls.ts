import {
  pgTable,
  pgEnum,
  pgSequence,
  text,
  integer,
  bigint,
  bigserial,
  real,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  primaryKey,
  foreignKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../auth/users';
import { userBoards } from './boards';
import { boardClimbs } from '../boards/unified';

/**
 * Spray walls — the per-wall state that does NOT belong on the catalogue rows.
 *
 * A spray wall is a runtime-created catalogue layout (SW-03, `docs/spray-walls.md`):
 * one `board_layouts` row plus one `board_product_sizes` row carrying the same
 * id, and one `board_holes` + `board_placements` pair per hold, again sharing an
 * id. That mapping is what makes queue, play, ticks, stats, playlists, feed,
 * comments, search and the duplicate gate work on a wall unchanged.
 *
 * ## Why a side table, not columns on `board_placements`
 *
 * Those catalogue rows are IMMUTABLE identity: a climb's frames string
 * (`p<placementId>r<code>`) points at a placement id forever, and every climb
 * ever set on the wall keeps pointing at the same `(board_type, layout_id)`
 * partition. Wall state is the opposite — it changes on every reset:
 *
 *   - a hold's lifecycle (installed in version 2, taken off the wall in
 *     version 5) is a RANGE, and a placement row has exactly one present tense;
 *   - a photo version carries its own anchors and homography, so the same hold
 *     has a different position in every version's photo;
 *   - a silhouette is primary data versioned with the wall, not an admin
 *     override of a tracer (which is what `hold_outline_overrides` is for).
 *
 * Adding those columns to `board_placements` would make every other board carry
 * nullable spray columns and would force a reset to rewrite catalogue rows that
 * climb frames depend on. Keying side tables by the same ids — the
 * `board_hold_features` / `hold_outline_overrides` precedent — keeps the
 * catalogue frozen and the wall's history append-only.
 */

/**
 * Both sequences stop at 2147483647 — `int4` max — because the columns they feed
 * are `integer`: `board_layouts.id`, `board_product_sizes.id`, `board_holes.id`
 * and `board_placements.id` all are, across every board type. A default bigint
 * sequence would hand out a value those columns cannot store, and the failure
 * would land on a climber creating a wall rather than on the sequence. Capped, it
 * fails where the id is drawn, with `nextval: reached maximum value`. At the caps
 * (10 walls per user, 1500 holds per wall) that ceiling is not a real bound.
 */
const CATALOGUE_ID_SEQUENCE_OPTIONS = { startWith: 1, increment: 1, maxValue: 2147483647 } as const;

/** Catalogue id space for walls: one value is BOTH the layout id and the size id. */
export const sprayWallCatalogIdSeq = pgSequence('spray_wall_catalog_id_seq', CATALOGUE_ID_SEQUENCE_OPTIONS);

/** Catalogue id space for holds: one value is BOTH the hole id and the placement id. */
export const sprayHoldCatalogIdSeq = pgSequence('spray_hold_catalog_id_seq', CATALOGUE_ID_SEQUENCE_OPTIONS);

/**
 * Lifecycle of one photo version.
 *
 * `draft` is being edited and is invisible to climbers; `published` is the
 * generation climbs are set against; `superseded` is what the previous
 * `published` becomes when a reset commits. A pgEnum rather than free text
 * because that is what every closed set in this schema uses.
 */
export const sprayWallVersionStatusEnum = pgEnum('spray_wall_version_status', ['draft', 'published', 'superseded']);

/** Where a hold's geometry came from: a detector run, or a human's hand. */
export const sprayHoldSourceEnum = pgEnum('spray_hold_source', ['manual', 'auto']);

/**
 * One physical wall. Its catalogue identity is `layout_id`; its owner, name,
 * angle, visibility and gym live on the `user_boards` row it points at, so
 * nothing about a wall is stored twice.
 */
export const sprayWalls = pgTable(
  'spray_walls',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /**
     * The `user_boards` row that owns this wall (owner, name, angle, visibility).
     *
     * `RESTRICT`, not `CASCADE`. `user_boards` rows are never hard-deleted — the
     * table's own comment in `schema/boards/unified.ts` says so, and a wall is
     * only ever soft-deleted through `deleted_at` — so a cascade would only ever
     * fire on a path that is not supposed to exist, and it would take the wall,
     * its versions and its whole hold history with it while every climb ever set
     * on the wall stayed behind pointing at an empty layout. Refusing the delete
     * surfaces the bug instead.
     */
    boardUuid: text('board_uuid')
      .notNull()
      .unique()
      .references(() => userBoards.uuid, { onDelete: 'restrict' }),
    /**
     * The wall's `board_layouts.id`, which is also its `board_product_sizes.id`
     * (`spraySizeIdForLayout`). Unique because a layout is exactly one wall.
     * Allocated from `spray_wall_catalog_id_seq`; no FK, because the catalogue
     * tables are keyed `(board_type, id)` and a partial-key FK is not
     * expressible.
     */
    layoutId: integer('layout_id').notNull().unique(),
    /**
     * The canonical frame, in pixels: the version-1 photo's anchor quad mapped
     * to a rectangle, or the version-1 photo's own frame when no anchors were
     * tapped. Every `spray_wall_holds` coordinate is in this frame. Derived, never
     * user-entered — the epic decided a wall has no real-world dimensions
     * (2026-09-14).
     */
    referenceWidth: integer('reference_width'),
    referenceHeight: integer('reference_height'),
    /**
     * The published version climbers see. NULL until the first publish — a wall
     * exists as soon as the photo is uploaded, and its first version is a draft.
     */
    currentVersionId: bigint('current_version_id', { mode: 'number' }).references(
      (): AnyPgColumn => sprayWallVersions.id,
      { onDelete: 'set null' },
    ),
    /** Alive holds in the current version; maintained by the wall writers (SW-05). */
    holdCount: integer('hold_count').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    /**
     * Soft delete, and the ONLY way a wall is ever deleted. The catalogue rows
     * and every climb set on the wall stay behind — a deleted wall stops being
     * reachable, it does not un-set the climbs.
     *
     * Stamping this is what tombstones the wall for offline clients: migration
     * 0228 fires `log_deletion_spray_walls()` on the `NULL -> NOT NULL`
     * transition, writing `layout_id` (the key the offline mirror knows a wall
     * by) scoped to the owner. The same function is also wired to a hard DELETE,
     * which should never happen, so that a wall removed by hand in psql still
     * reaches the phones that have it.
     */
    deletedAt: timestamp('deleted_at'),
    /**
     * Set by an admin acting on a report (SW-17). A hidden wall reads exactly like
     * a PRIVATE one to everybody but its owner — it leaves gym lists, the web view
     * and its share link, and its climbs drop out of every read that carries the
     * spray visibility predicate — while the owner keeps seeing it, with a notice
     * saying so.
     *
     * A timestamp rather than a boolean, because "when" is the only thing an
     * appeal ever asks about, and a boolean would have needed the column beside it
     * anyway. NULL is the overwhelmingly common case and costs nothing.
     *
     * Not a soft delete: nothing is scheduled for deletion, no tombstone is
     * written, and clearing it restores the wall exactly as it was. The two are
     * independent — a hidden wall can also be deleted.
     */
    hiddenAt: timestamp('hidden_at'),
    /**
     * The admin who set `hidden_at`. `set null` on user delete: the fact that a
     * wall is hidden must outlive the account that hid it, and the reports behind
     * it are the record of why.
     */
    hiddenBy: text('hidden_by').references(() => users.id, { onDelete: 'set null' }),
    /**
     * When the retention purge swept this wall's object-storage prefix (SW-17).
     *
     * Explicit state rather than "does a version still have a photo key", and both
     * halves of that matter:
     *
     *  - a purged wall's ROW is never deleted, so it stays past the retention
     *    cutoff forever. Inferring "already done" from the version rows means the
     *    candidate query cannot express it cheaply, and filtering after `LIMIT`
     *    starves every deletion past the first batch;
     *  - a wall can own objects with NO version pointing at them — a photo
     *    uploaded into the wizard that was then abandoned. Those are exactly the
     *    strays worth deleting, and no version row names them, so "has a photo
     *    key" would skip the wall and leave them in the bucket forever.
     *
     * Stamped only after the objects are gone, so a failed sweep (or a backend
     * with no bucket configured) leaves it NULL and the next run takes the wall
     * again.
     */
    photosPurgedAt: timestamp('photos_purged_at'),
  },
  (table) => ({
    currentVersionIdx: index('spray_walls_current_version_idx').on(table.currentVersionId),
    /**
     * The retention purge's candidate read (SW-17): the oldest soft-deleted walls
     * whose objects have not been swept yet. Partial on BOTH conditions, so the
     * index holds only rows that are actually work — `deleted_at IS NULL` is the
     * overwhelming majority of the table, and a purged wall never needs to be
     * found again.
     */
    deletedAtIdx: index('spray_walls_deleted_at_idx')
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} IS NOT NULL AND ${table.photosPurgedAt} IS NULL`),
  }),
);

/**
 * Why a climber reported a wall. A closed set, not free text.
 *
 * Free text would be a moderation surface of its own — it has to be read, stored
 * and shown to an admin, and at this volume nothing is gained by it. Four reasons
 * cover what a wall photograph can actually be reported for, and `other` is the
 * escape hatch that keeps the list from having to be complete.
 */
export const sprayWallReportReasonEnum = pgEnum('spray_wall_report_reason', [
  'inappropriate',
  'not_a_wall',
  'personal_info',
  'other',
]);

/**
 * One climber's report of one wall.
 *
 * Deliberately NOT the `climb_proposals` vote machinery (`docs/climb-moderation.md`):
 * that is a weighted approval threshold over a change to a CLIMB — its holds, its
 * name, its grade — where the community is the right judge and the outcome is a
 * catalogue edit. A wall photograph is somebody's home, the question is a safety
 * one, and it has exactly one right answer, so the queue is a list an admin reads
 * and `spray_walls.hidden_at` is the only outcome.
 *
 * One row per (wall, reporter): reporting twice is the same report, and the unique
 * index is what keeps a single climber from filling the queue. A reporter whose
 * account is deleted leaves the row behind with a NULL reporter — the report is
 * about the wall, not the person.
 */
export const sprayWallReports = pgTable(
  'spray_wall_reports',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    wallId: bigint('wall_id', { mode: 'number' })
      .notNull()
      .references(() => sprayWalls.id, { onDelete: 'cascade' }),
    reporterId: text('reporter_id').references(() => users.id, { onDelete: 'set null' }),
    reason: sprayWallReportReasonEnum('reason').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    /** Stamped when an admin acts — whether they hid the wall or decided not to. */
    reviewedAt: timestamp('reviewed_at'),
    reviewedBy: text('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => ({
    /**
     * One report per climber per wall; a second `reportSprayWall` is an
     * idempotent no-op rather than a second row.
     *
     * Partial on `reporter_id IS NOT NULL`, which is honesty rather than a
     * loosening: Postgres does not consider two NULLs equal, so the unpartitioned
     * index never constrained orphaned rows either — it just looked as though it
     * did. Deleting an account nulls its reports' `reporter_id` (the report is
     * about the wall, not the person), so several orphans per wall are possible
     * and correct; `NULLS NOT DISTINCT` would instead make the SECOND account
     * deletion fail the FK's own update, which is a far worse outcome than a
     * queue row appearing twice.
     */
    reporterUnique: uniqueIndex('spray_wall_reports_wall_reporter_idx')
      .on(table.wallId, table.reporterId)
      .where(sql`${table.reporterId} IS NOT NULL`),
    // The admin queue's read: everything still waiting, newest first.
    pendingIdx: index('spray_wall_reports_pending_idx')
      .on(table.createdAt)
      .where(sql`${table.reviewedAt} IS NULL`),
  }),
);

/**
 * One photograph of the wall. Version 1 is the wall's first photo; every reset
 * adds another. A version NEVER creates a new layout or a new size — see
 * `docs/spray-walls.md` "What the version is not".
 */
export const sprayWallVersions = pgTable(
  'spray_wall_versions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    wallId: bigint('wall_id', { mode: 'number' })
      .notNull()
      .references(() => sprayWalls.id, { onDelete: 'cascade' }),
    /** 1-based, dense per wall. Capped by `MAX_VERSIONS_PER_WALL`. */
    versionNumber: integer('version_number').notNull(),
    status: sprayWallVersionStatusEnum('status').default('draft').notNull(),
    /** Object key in the PRIVATE R2 bucket; read through a 15-minute presigned URL. */
    photoKey: text('photo_key'),
    photoWidth: integer('photo_width'),
    photoHeight: integer('photo_height'),
    /**
     * The four corners of the wall in THIS photo's pixels, in TL/TR/BR/BL order,
     * as `[[x, y], …]`. NULL means "the photo frame is the quad" — anchors are
     * optional at creation and required at the first reset, because that is the
     * point at which two photographs have to agree on where a hold is.
     */
    anchors: jsonb('anchors').$type<[number, number][]>(),
    /**
     * Row-major 3x3 photo→canonical homography, nine floats. The identity matrix
     * when the version has no anchors. No image is ever warped in v1: holds are
     * mapped through the INVERSE of this at render time.
     */
    homography: jsonb('homography').$type<number[]>(),
    /** What changed in this reset, in the wall owner's own words. */
    notes: text('notes'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    publishedAt: timestamp('published_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    wallVersionUnique: uniqueIndex('spray_wall_versions_wall_version_idx').on(table.wallId, table.versionNumber),
  }),
);

/**
 * One hold on one wall, across its whole life.
 *
 * `installed_version_id` / `removed_version_id` are the range: NULL removed
 * means the hold is still on the wall. A reset never updates geometry in place
 * and never deletes a row — a moved hold is a removal plus an addition, linked
 * by `moved_from_hold_id` so remix can suggest the successor — so the table is
 * append-only apart from stamping a removal.
 *
 * `hold_id` is the wall's `board_holes.id` AND its `board_placements.id`
 * (they are the same number by definition), allocated from
 * `spray_hold_catalog_id_seq`. That is what makes a climb's frames string join
 * straight onto this table.
 */
export const sprayWallHolds = pgTable(
  'spray_wall_holds',
  {
    wallId: bigint('wall_id', { mode: 'number' })
      .notNull()
      .references(() => sprayWalls.id, { onDelete: 'cascade' }),
    holdId: integer('hold_id').notNull(),
    /** Centre and radius in the wall's canonical frame (see `spray_walls.reference_*`). */
    cx: integer('cx').notNull(),
    cy: integer('cy').notNull(),
    r: integer('r').notNull(),
    /**
     * Flat implicitly-closed ring `[x0, y0, x1, y1, …]` in units of the hold's
     * own radius relative to its centre — the SAME contract as
     * `hold_outline_overrides.outline` and the renderer's rings, so a consumer
     * can swap one for the other with no conversion. NULL falls back to the
     * circle `(cx, cy, r)` describes.
     */
    outline: jsonb('outline').$type<number[]>(),
    installedVersionId: bigint('installed_version_id', { mode: 'number' })
      .notNull()
      .references(() => sprayWallVersions.id, { onDelete: 'cascade' }),
    /**
     * NULL = still on the wall. Set by the reset that took the hold off.
     *
     * `RESTRICT`: NULL here means "alive", so nulling this on a version delete
     * would resurrect every hold that version removed — silently making lost
     * climbs whole again and zeroing their `missing_hold_count`. A version that
     * still carries removals cannot be deleted; a wall's history is append-only.
     */
    removedVersionId: bigint('removed_version_id', { mode: 'number' }).references(() => sprayWallVersions.id, {
      onDelete: 'restrict',
    }),
    /** The hold this one replaced, when the reset review linked a move. */
    movedFromHoldId: integer('moved_from_hold_id'),
    source: sprayHoldSourceEnum('source').default('manual').notNull(),
    /** Detector confidence 0-1 for `source = 'auto'`; NULL when a human drew it. */
    confidence: real('confidence'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.wallId, table.holdId] }),
    // The alive-holds read: every render, every create-climb session and the
    // integrity recompute filter `wall_id = ? AND removed_version_id IS NULL`.
    aliveIdx: index('spray_wall_holds_alive_idx').on(table.wallId, table.removedVersionId),
    // Remix walks the other way — "what replaced the hold this climb lost?" —
    // and almost every row has no predecessor, so the index is partial.
    movedFromIdx: index('spray_wall_holds_moved_from_idx')
      .on(table.movedFromHoldId)
      .where(sql`${table.movedFromHoldId} IS NOT NULL`),
  }),
);

/**
 * Remix lineage: which climb this one was rebuilt from, and on which version of
 * the wall it was rebuilt.
 *
 * `child_uuid` is the PK because a climb has exactly one parent. `parent_uuid`
 * carries no FK on purpose, following `board_climb_aliases`: the parent may be
 * hidden, or unclimbable after the reset that prompted the remix, and losing the
 * lineage row would erase the link the child's screen shows.
 */
export const sprayClimbLineage = pgTable(
  'spray_climb_lineage',
  {
    childUuid: text('child_uuid').primaryKey(),
    parentUuid: text('parent_uuid').notNull(),
    /**
     * The wall version the child was set against.
     *
     * `RESTRICT`, like the other two version FKs: cascading would delete the
     * lineage row itself, silently erasing the link between a remix and the climb
     * it came from — the one place a climber can still see the parent's ticks and
     * grade history. A version's rows are never deleted.
     */
    wallVersionId: bigint('wall_version_id', { mode: 'number' })
      .notNull()
      .references(() => sprayWallVersions.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => ({
    childFk: foreignKey({
      columns: [table.childUuid],
      foreignColumns: [boardClimbs.uuid],
      name: 'spray_climb_lineage_child_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    // "What was remixed off this climb?" — the parent's screen lists its children.
    parentIdx: index('spray_climb_lineage_parent_idx').on(table.parentUuid),
  }),
);

export type SprayWallVersionStatus = (typeof sprayWallVersionStatusEnum.enumValues)[number];
export type SprayHoldSource = (typeof sprayHoldSourceEnum.enumValues)[number];

export type SprayWall = typeof sprayWalls.$inferSelect;
export type NewSprayWall = typeof sprayWalls.$inferInsert;
export type SprayWallVersion = typeof sprayWallVersions.$inferSelect;
export type NewSprayWallVersion = typeof sprayWallVersions.$inferInsert;
export type SprayWallHold = typeof sprayWallHolds.$inferSelect;
export type NewSprayWallHold = typeof sprayWallHolds.$inferInsert;
export type SprayClimbLineage = typeof sprayClimbLineage.$inferSelect;
export type NewSprayClimbLineage = typeof sprayClimbLineage.$inferInsert;
export type SprayWallReportReason = (typeof sprayWallReportReasonEnum.enumValues)[number];
export type SprayWallReport = typeof sprayWallReports.$inferSelect;
export type NewSprayWallReport = typeof sprayWallReports.$inferInsert;
