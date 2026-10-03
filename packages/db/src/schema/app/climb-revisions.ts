import { pgTable, text, integer, bigint, timestamp, index, primaryKey, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../auth/users';
import { boardClimbs } from '../boards/unified';
import { sprayWallVersions } from './spray-walls';

/**
 * What an edit can change, as stored in `board_climb_revisions.changes`.
 *
 * `holds` covers the frames string and its frame count/pace; `rules` is the
 * characteristics array (no match, any feet, campus, no kickboard). `grade` only
 * ever appears on a spray wall, the one board whose grade is the setter's to edit.
 */
export const CLIMB_REVISION_CHANGES = ['name', 'description', 'holds', 'grade', 'angle', 'rules'] as const;
export type ClimbRevisionChange = (typeof CLIMB_REVISION_CHANGES)[number];

/**
 * The edit history of a published climb (#5955).
 *
 * Each row is the climb AS IT STOOD AFTER an edit, so the highest-numbered row
 * always equals the live `board_climbs` row. Rows are written lazily by
 * `updateClimb`:
 *
 *  - a climb nobody has edited has NO rows. The live row is its only revision;
 *  - the first edit of a published climb writes revision 1 (the climb as it was
 *    published, `created_at` = its `published_at`, `edited_by` = its setter) and
 *    revision 2 (the new state). Every later edit writes one row;
 *  - drafts never record, and neither does the save that publishes a draft.
 *
 * Capped per climb by `MAX_REVISIONS_PER_CLIMB`. Past the cap the oldest EDIT is
 * dropped and revision 1 is kept, so the original is always there to compare
 * against. Numbers are never reused, so they stop being dense once a climb has
 * been pruned.
 *
 * Lives here rather than beside `board_climbs` in `boards/unified.ts` because it
 * references `spray_wall_versions`, and `app/spray-walls.ts` already imports
 * `boards/unified.ts`.
 */
export const boardClimbRevisions = pgTable(
  'board_climb_revisions',
  {
    boardType: text('board_type').notNull(),
    climbUuid: text('climb_uuid').notNull(),
    /** 1-based per climb. 1 is always the climb as first published. */
    revisionNumber: integer('revision_number').notNull(),
    // --- the snapshot: the editable columns of `board_climbs`, as they stood ---
    name: text('name'),
    description: text('description'),
    frames: text('frames'),
    framesCount: integer('frames_count'),
    framesPace: integer('frames_pace'),
    angle: integer('angle'),
    characteristics: text('characteristics').array(),
    /**
     * The setter grade at this revision. Spray walls only: every other board's
     * grade comes from ticks or the Aurora sync, so it is not part of an edit and
     * stays NULL.
     */
    difficultyId: integer('difficulty_id'),
    /**
     * The wall version this revision was drawn on, so an old revision can be shown
     * on the photograph it was set against. Spray walls only.
     *
     * NULL on every other board, and on a revision 1 whose version could not be
     * worked out after the fact (the client then shows it without a board).
     *
     * `RESTRICT`, like the other version FKs: only a draft version is ever
     * deleted, and a revision only ever points at a version that was published.
     */
    sprayWallVersionId: bigint('spray_wall_version_id', { mode: 'number' }).references(() => sprayWallVersions.id, {
      onDelete: 'restrict',
    }),
    /** What this revision changed against the one before it. Empty on revision 1. */
    changes: text('changes')
      .array()
      .$type<ClimbRevisionChange[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * Who made the edit. The setter, or on a spray wall anyone who can edit the
     * wall. `set null` so the history outlives the account.
     */
    editedBy: text('edited_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // `climb_uuid` leads, ahead of `board_type`: a climb uuid is unique on its
    // own, and the cascade a climb delete runs filters on `climb_uuid` alone. With
    // `board_type` first that cascade would scan the table once per deleted climb.
    pk: primaryKey({ columns: [table.climbUuid, table.boardType, table.revisionNumber] }),
    climbFk: foreignKey({
      columns: [table.climbUuid],
      foreignColumns: [boardClimbs.uuid],
      name: 'board_climb_revisions_climb_fk',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    // The FK check a draft version's delete runs. Almost every row is NULL here
    // (every catalogue board), so the index is partial.
    sprayWallVersionIdx: index('board_climb_revisions_spray_wall_version_idx')
      .on(table.sprayWallVersionId)
      .where(sql`${table.sprayWallVersionId} IS NOT NULL`),
  }),
);

export type BoardClimbRevision = typeof boardClimbRevisions.$inferSelect;
export type NewBoardClimbRevision = typeof boardClimbRevisions.$inferInsert;
