import { pgTable, bigint, text, timestamp, index } from 'drizzle-orm/pg-core';
import { gyms } from './gyms';

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
  },
  (table) => ({
    gymIdx: index('location_sync_gym_sources_gym_idx').on(table.gymId),
  }),
);

export type LocationSyncGymSource = typeof locationSyncGymSources.$inferSelect;
export type NewLocationSyncGymSource = typeof locationSyncGymSources.$inferInsert;
