import { pgTable, bigint, text, timestamp, index, boolean, integer } from 'drizzle-orm/pg-core';
import { gyms } from './gyms';
import { userBoards } from './boards';

/** Exact public Kilter wall provenance. Source identity survives board merges. */
export const kilterWallSources = pgTable(
  'kilter_wall_sources',
  {
    sourceKey: text('source_key').primaryKey(),
    sourceBoardUuid: text('source_board_uuid')
      .notNull()
      .references(() => userBoards.uuid, { onDelete: 'cascade' }),
    gymUuid: text('gym_uuid').notNull(),
    productLayoutUuid: text('product_layout_uuid').notNull(),
    wallUuid: text('wall_uuid').notNull(),
    layoutId: integer('layout_id').notNull(),
    sizeId: integer('size_id').notNull(),
    setIds: text('set_ids').notNull(),
    isListed: boolean('is_listed').notNull().default(true),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({ sourceBoardIdx: index('kilter_wall_sources_board_idx').on(table.sourceBoardUuid) }),
);

/**
 * Maps upstream public-location source keys to the canonical Boardsesh gym row.
 *
 * Location providers use different identifiers for the same physical gym
 * (for example Kilter's gym UUID vs Tension's pin ID). Keeping the source alias
 * separate lets sync jobs preserve deterministic source ownership without
 * minting duplicate public gym entities.
 */
export const locationSyncGymSources = pgTable(
  'location_sync_gym_sources',
  {
    sourceKey: text('source_key').primaryKey(),
    gymId: bigint('gym_id', { mode: 'number' })
      .references(() => gyms.id, { onDelete: 'cascade' })
      .notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    // When this gym's walls were last read from the provider's authenticated
    // per-gym endpoint. NULL means never read, which is also the state every
    // row starts in — the crawl treats those as highest priority.
    //
    // Deliberately NOT `updated_at`: that moves whenever the alias row is
    // touched for any reason, so it can't distinguish "we have real wall data
    // for this gym" from "we upserted the guessed default again". The crawl's
    // resume order, its weekly re-read floor, and the rule that stops the
    // cheap hourly sync overwriting enriched rows all key off this column.
    wallsCrawledAt: timestamp('walls_crawled_at'),
  },
  (table) => ({
    gymIdx: index('location_sync_gym_sources_gym_idx').on(table.gymId),
    // The crawl asks for "the stalest N source keys for this provider" every
    // cycle; without this it seq-scans the whole alias table each time.
    // NULLS FIRST matches the query's ordering so the index actually serves it.
    crawlOrderIdx: index('location_sync_gym_sources_crawl_order_idx').on(table.wallsCrawledAt),
  }),
);

export type LocationSyncGymSource = typeof locationSyncGymSources.$inferSelect;
export type NewLocationSyncGymSource = typeof locationSyncGymSources.$inferInsert;
