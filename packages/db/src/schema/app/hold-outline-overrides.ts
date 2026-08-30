import { pgTable, text, integer, jsonb, timestamp, bigserial, index, uniqueIndex, pgEnum } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';

/**
 * What a stored ring is tracing.
 *
 * `silhouette` is the hold's outer boundary — the shape the tracer produces and
 * the renderer lights.
 *
 * `led_inner` is the INNER boundary of the same hold's LED base plate: the ring
 * of plate visible around the hold proper. The lit region is the silhouette
 * MINUS this polygon, so a `led_inner` row is only meaningful alongside the
 * silhouette it sits inside, and stores no part of the outer edge itself.
 *
 * A pgEnum rather than free text because that is what every closed set in this
 * schema uses — tick_status, gym_member_role, proposal_type, qa_verdict_kind.
 */
export const holdOutlineKindEnum = pgEnum('hold_outline_kind', ['silhouette', 'led_inner']);

/**
 * A hand-corrected hold outline, overriding what the tracer produced.
 *
 * `@boardsesh/board-art-geometry` traces every hold's outline from the board art
 * (issue #2202) and ships the result as a frozen shard per `(board, layout,
 * size)`. The tracer is good but not perfect: a hold whose art overlaps a
 * neighbour, or whose photograph carries a shadow, comes out with an outline a
 * human can see is wrong. This table is where that human's correction lives, so
 * a fix ships as a row rather than as a regenerated 3 MB shard set. It also
 * holds annotations the tracer never produced at all — see `kind`.
 *
 * The key is deliberately the shard's own merge key plus a placement and a kind:
 * `(board_name, layout_id, size_id, placement_id, kind)`. There is no set-id
 * column because there is no set-id component in the shard key either — every
 * shard is traced with EVERY set of its layout and size mounted (see
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
    /** Which boundary of the hold this ring traces. See {@link holdOutlineKindEnum}. */
    kind: holdOutlineKindEnum('kind').default('silhouette').notNull(),
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
      table.kind,
    ),
    configIdx: index('hold_outline_overrides_config_idx').on(table.boardName, table.layoutId, table.sizeId),
  }),
);

export type HoldOutlineKind = (typeof holdOutlineKindEnum.enumValues)[number];
export type HoldOutlineOverrideRow = typeof holdOutlineOverrides.$inferSelect;
export type NewHoldOutlineOverrideRow = typeof holdOutlineOverrides.$inferInsert;
