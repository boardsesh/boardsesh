import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { oauthConnections } from '../auth/partner-oauth';
import { users } from '../auth/users';
import { xid8 } from './logbook-changes';

/**
 * A tick as a snapshot chunk stores it: the serializer's columns, exactly as
 * the change feed reads them (`LogbookFeedTick` in services/logbook-feed.ts),
 * captured as JSON so a chunk can be read back in one row lookup.
 */
export type LogbookSnapshotChunkTick = {
  uuid: string;
  boardType: string;
  climbUuid: string;
  canonicalClimbUuid: string;
  angle: number;
  isMirror: boolean | null;
  status: string;
  attemptCount: number;
  quality: number | null;
  difficulty: number | null;
  isBenchmark: boolean | null;
  comment: string | null;
  climbedAt: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * `building` until every tick is copied, then `ready`. `too_large` ends a build
 * over the cap and `stalled` one whose chunk kept timing out; both refuse a
 * restart until they expire. `retired` means it was replaced: never readable
 * again, waiting for the reclaim job.
 */
export type LogbookSnapshotStatus = 'building' | 'ready' | 'too_large' | 'stalled' | 'retired';

/**
 * Temporary snapshots behind the logbook bootstrap (docs/integration-platform.md,
 * "Complete bootstrap and transition"). A complete copy of a climber's visible
 * ticks, bound to one app/climber connection, that an app downloads once before
 * following the change feed from `(horizon_txid, 0)`.
 *
 * Bound to the connection on every read, unreadable once `expires_at` passes
 * even if the reclaim job has not run, and `user_id` cascades so a deleted
 * account's copy goes with it. `expires_at` is the build deadline until the copy
 * finishes, then one hour.
 *
 * `connection_id` cascades from `oauth_connections`, so deleting a connection
 * row (its app deleted, or its climber's account) takes the copy with it. A
 * Disconnect keeps the row and moves its generation on, which already makes
 * every snapshot of the old generation unreadable.
 */
export const logbookSnapshots = pgTable(
  'logbook_snapshots',
  {
    id: uuid('id').primaryKey().notNull().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => oauthConnections.id, { onDelete: 'cascade' }),
    connectionGeneration: integer('connection_generation').notNull(),
    /** Feed generation when the snapshot started: every page and the final cursor carry it. */
    feedGeneration: uuid('feed_generation').notNull(),
    /** The hand-off point H: catch-up after this snapshot starts at change position `(H, 0)`. */
    horizonTxid: xid8('horizon_txid').notNull(),
    status: text('status').$type<LogbookSnapshotStatus>().notNull().default('building'),
    tickCount: integer('tick_count').notNull().default(0),
    chunkCount: integer('chunk_count').notNull().default(0),
    /** Keyset position of the next tick to copy; null until the first chunk is written. */
    nextUpdatedAt: timestamp('next_updated_at', { mode: 'string' }),
    nextTickId: bigint('next_tick_id', { mode: 'bigint' }),
    /** Statement timeouts since the last copied chunk. At the limit the build ends as `stalled`. */
    chunkTimeoutStreak: integer('chunk_timeout_streak').notNull().default(0),
    /** Set after a timeout, so one build cannot hold a slot back to back. */
    retryNotBefore: timestamp('retry_not_before', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => ({
    // One active build per connection. Every other status is free to repeat.
    oneBuildPerConnection: uniqueIndex('logbook_snapshots_one_build_per_connection_idx')
      .on(table.connectionId)
      .where(sql`"status" = 'building'`),
    connectionIdx: index('logbook_snapshots_connection_id_idx').on(table.connectionId),
    // The FK cascade from users, and a climber's own snapshots.
    userIdIdx: index('logbook_snapshots_user_id_idx').on(table.userId),
    // The reclaim job's scan: rows past their expiry, oldest first.
    expiresAtIdx: index('logbook_snapshots_expires_at_idx').on(table.expiresAt),
  }),
);

/**
 * The stored ticks, in fixed-size chunks of one maximum feed page. A whole
 * chunk is one row, so a 100,000-tick snapshot is 500 rows to write, read and
 * reclaim rather than 100,000: the bound on what one snapshot can cost the
 * primary. Every chunk but the last holds exactly `LOGBOOK_SNAPSHOT_CHUNK_TICKS`
 * ticks, so a position in the stream maps to a chunk by division.
 */
export const logbookSnapshotChunks = pgTable(
  'logbook_snapshot_chunks',
  {
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => logbookSnapshots.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    ticks: jsonb('ticks').$type<LogbookSnapshotChunkTick[]>().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.snapshotId, table.chunkIndex] }),
  }),
);

export type LogbookSnapshot = typeof logbookSnapshots.$inferSelect;
export type LogbookSnapshotChunk = typeof logbookSnapshotChunks.$inferSelect;
