import { pgTable, bigserial, integer, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Durable provenance for every `boardsesh_ticks.climbed_at` value rewritten by
 * the #3909 legacy-timezone correction.
 *
 * The table exists so a correction is REVERSIBLE and AUDITABLE without the
 * operator having to keep a JSON file alive: `--revert <run-id>` reads these
 * rows back. The precedent script (backfill-clamped-send-attempts.ts) snapshots
 * to a local file, which is fine for a few thousand rows run from one laptop
 * and not fine for a six-figure fleet-wide rewrite whose undo must survive the
 * machine that started it.
 *
 * It ships EMPTY. Creating it changes zero ticks; only a deliberate, explicitly
 * flagged run of packages/db/scripts/backfill-mislabeled-tick-timezones.ts ever
 * writes a row here.
 *
 * `tickUuid` and `userId` are deliberately NOT foreign keys: the audit of what
 * was changed must outlive a later hard-delete of the tick or the account.
 */
export const tickClimbedAtCorrections = pgTable(
  'tick_climbed_at_corrections',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // Groups every row written by one invocation, and the handle `--revert` takes.
    runId: text('run_id').notNull(),
    tickUuid: text('tick_uuid').notNull(),
    userId: text('user_id').notNull(),
    boardType: text('board_type').notNull(),
    // The tick's origin at correction time ('json_import' | 'aurora_pull' | 'native').
    origin: text('origin').notNull(),
    previousClimbedAt: timestamp('previous_climbed_at', { mode: 'string' }).notNull(),
    correctedClimbedAt: timestamp('corrected_climbed_at', { mode: 'string' }).notNull(),
    // Seconds SUBTRACTED from previous_climbed_at to reach corrected_climbed_at.
    offsetSeconds: integer('offset_seconds').notNull(),
    // Distinct (canonical climb, angle) anchor keys the offset was derived from.
    anchorKeyCount: integer('anchor_key_count').notNull(),
    // 'native' | 'kilter_pull' — which honest-UTC family backed the offset.
    anchorTrust: text('anchor_trust').notNull(),
    // JSON blob of the per-key deltas and bucket stats behind the decision, so a
    // reviewer can re-derive the call months later without re-running the report.
    evidence: text('evidence').notNull(),
    revertedAt: timestamp('reverted_at', { mode: 'string' }),
    createdAt: timestamp('created_at', { mode: 'string' }).defaultNow().notNull(),
  },
  (table) => ({
    runIdx: index('tick_climbed_at_corrections_run_idx').on(table.runId),
    // One correction per tick per run: makes a re-run of the same run id
    // idempotent instead of stacking duplicate undo rows.
    runTickUnique: uniqueIndex('tick_climbed_at_corrections_run_tick_unique').on(table.runId, table.tickUuid),
    tickHistoryIdx: index('tick_climbed_at_corrections_tick_history_idx').on(table.tickUuid, table.createdAt),
  }),
);

export type TickClimbedAtCorrection = typeof tickClimbedAtCorrections.$inferSelect;
export type NewTickClimbedAtCorrection = typeof tickClimbedAtCorrections.$inferInsert;
