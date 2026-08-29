import { pgTable, text, integer, jsonb, timestamp, bigserial, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

/**
 * A hand-corrected hold silhouette, overriding what the tracer produced.
 *
 * `@boardsesh/board-art-geometry` traces every hold's outline from the board art
 * (issue #2202) and ships the result as a frozen shard per `(board, layout,
 * size)`. The tracer is good but not perfect: a hold whose art overlaps a
 * neighbour, or whose photograph carries a shadow, comes out with an outline a
 * human can see is wrong. This table is where that human's correction lives, so
 * a fix ships as a row rather than as a regenerated 3 MB shard set.
 *
 * The key is deliberately the shard's own merge key plus a placement:
 * `(board_name, layout_id, size_id, placement_id)`. There is no set-id column
 * because there is no set-id component in the shard key either — every shard is
 * traced with EVERY set of its layout and size mounted (see
 * `BoardArtGeometryKey`), so an override that named a set would be answering a
 * question no consumer asks. Per-size rows because the same layout traced at
 * another size is a different photograph.
 *
 * Latest write wins and there is no history table: `author_id`, `updated_at` and
 * `note` already answer who changed it, when, and why, and an outline is a
 * drawing rather than a ledger — nobody audits the intermediate shapes.
 */
export const holdOutlineOverrides = pgTable(
  'hold_outline_overrides',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boardName: text('board_name').notNull(),
    layoutId: integer('layout_id').notNull(),
    sizeId: integer('size_id').notNull(),
    placementId: integer('placement_id').notNull(),
    /**
     * Flat implicitly-closed ring `[x0, y0, x1, y1, ...]` in units of the
     * placement's own radius relative to its centre, rounded to 4 decimals —
     * exactly the shape and units of the shard's `outlines` value for this
     * placement, so a consumer can swap one for the other with no conversion.
     */
    outline: jsonb('outline').$type<number[]>().notNull(),
    /** Why the tracer's version was wrong, in the editor's own words. */
    note: text('note'),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    placementUnique: uniqueIndex('hold_outline_overrides_placement_idx').on(
      table.boardName,
      table.layoutId,
      table.sizeId,
      table.placementId,
    ),
    configIdx: index('hold_outline_overrides_config_idx').on(table.boardName, table.layoutId, table.sizeId),
  }),
);

export type HoldOutlineOverrideRow = typeof holdOutlineOverrides.$inferSelect;
export type NewHoldOutlineOverrideRow = typeof holdOutlineOverrides.$inferInsert;
