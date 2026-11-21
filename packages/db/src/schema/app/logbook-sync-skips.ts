import { pgTable, text, integer, jsonb, timestamp, bigserial, index, uniqueIndex, pgEnum } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';
import { auroraTableTypeEnum } from './ascents';

/**
 * Why one upstream logbook row could not be written.
 *
 * Machine-stable strings, not sentences: they are the grouping key for the
 * triage query in docs/data/aurora-sync.md, so re-wording one silently splits a
 * cluster in two. Add a value here rather than free-texting into `detail`.
 *
 * - invalid_angle      angle isn't a finite int4. Unwritable (`angle` is NOT
 *                      NULL) and there is no honest default — a tick at a
 *                      guessed angle is wrong data.
 * - invalid_identity   climb_uuid / aurora_id missing or carrying a byte
 *                      Postgres can't store (NUL, lone surrogate). The row
 *                      can't be keyed, so it can't be deduped or re-synced.
 * - normalize_failed   the row threw in normalizeAscent/normalizeBid — the
 *                      parse-time class PR #3872 (issue #3520) skips-and-logs.
 * - db_write_rejected  the row parsed and validated but Postgres still refused
 *                      it. The catch-all: whatever validation didn't predict.
 *
 * Enforced as a pgEnum rather than free `text`: these are the GROUPING KEY of
 * the triage query, so one caller inserting an off-contract string would split
 * a cluster in two and quietly under-report it — the same class of hiding this
 * whole table exists to prevent. Adding a value needs an `ALTER TYPE … ADD
 * VALUE` migration, which is the intended friction.
 */
export const logbookSyncSkipReasonEnum = pgEnum('logbook_sync_skip_reason', [
  'invalid_angle',
  'invalid_identity',
  'normalize_failed',
  'db_write_rejected',
]);

export const LOGBOOK_SYNC_SKIP_REASONS = logbookSyncSkipReasonEnum.enumValues;

export type LogbookSyncSkipReason = (typeof LOGBOOK_SYNC_SKIP_REASONS)[number];

/**
 * Upstream logbook rows the Aurora sync could not write — the quarantine that
 * makes dropping a row an acceptable outcome instead of silent data loss.
 *
 * ## Why this table exists
 *
 * A single upstream row that Postgres refuses (non-finite `angle`, a NUL byte
 * in a comment, a duplicate `aurora_id`) used to abort the batched chunk write
 * in applyLogbookChunk, which aborted syncUserData's ONE cross-table
 * transaction, which rolled back ascents, bids, circuits AND the sync
 * checkpoint together. The next cycle re-fetched the same row and re-crashed:
 * the user's logbook stopped updating permanently, with nothing surfaced
 * (#3871 — the DB-execution-time sibling of the parse-time wedge #3520).
 *
 * The fix skips the offending row and lets the checkpoint advance. That trade
 * is only defensible because of THIS table: `payload` keeps the normalized row,
 * so a skipped send is quarantined and replayable, not gone. Without it the fix
 * would be silently discarding a climber's send.
 *
 * ## Why a table and not a counter
 *
 * Aurora's user sync is incremental — the watermark advances even on a cycle
 * that skipped everything — so a per-cycle counter reports the problem once and
 * then clears itself on the next cycle, when the delta is empty and nothing was
 * skipped because nothing arrived. That is exactly how #3523's equivalent bug
 * stayed hidden for years. This table is STATE: a row persists while the
 * condition persists, and the sync deletes it the moment that `aurora_id`
 * writes cleanly (see reconcileLogbookSyncSkips), so a query against it always
 * answers "what is broken right now", never "what ever broke".
 *
 * Triage query + reason codes: docs/data/aurora-sync.md.
 */
export const logbookSyncSkips = pgTable(
  'logbook_sync_skips',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Any AuroraBoardName — kilter, tension, decoy, touchstone, grasshopper, …
    // Left as text (not an enum) to match board_type everywhere else in the
    // schema, so adding a board never needs a migration here.
    boardType: text('board_type').notNull(),
    auroraType: auroraTableTypeEnum('aurora_type').notNull(),
    /** The upstream row's uuid. Kept as text: an unparseable id is still an id. */
    auroraId: text('aurora_id').notNull(),
    reason: logbookSyncSkipReasonEnum('reason').notNull(),
    /** The Postgres error / validation detail, for triage. */
    detail: text('detail'),
    /**
     * The normalized row (or the raw upstream item when normalization itself
     * threw). This is what makes the skip replayable — without it a drop is
     * indistinguishable from throwing the user's send away.
     */
    payload: jsonb('payload'),
    firstSeenAt: timestamp('first_seen_at', { mode: 'string', withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { mode: 'string', withTimezone: true }).defaultNow().notNull(),
    /** Bumped each time the same row is re-delivered and re-refused. */
    seenCount: integer('seen_count').notNull().default(1),
  },
  (table) => ({
    // Scoped per user, NOT globally on aurora_id: the same upstream row can be
    // attempted for two Boardsesh accounts linked to one Aurora login (#3526),
    // and each attempt is its own fact.
    rowUnique: uniqueIndex('logbook_sync_skips_row_unique').on(
      table.userId,
      table.boardType,
      table.auroraType,
      table.auroraId,
    ),
    // Drives both the per-user reconcile delete and the "who is affected"
    // triage query.
    userBoardIdx: index('logbook_sync_skips_user_board_idx').on(table.userId, table.boardType),
    // "How many users is each reason hitting, and is it getting worse?"
    reasonSeenIdx: index('logbook_sync_skips_reason_seen_idx').on(table.reason, table.lastSeenAt),
  }),
);

export type LogbookSyncSkip = typeof logbookSyncSkips.$inferSelect;
export type NewLogbookSyncSkip = typeof logbookSyncSkips.$inferInsert;
