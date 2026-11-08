import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/** Server-only writer fence shared by catalog, incremental refresh and repairs. */
export const kilterCatalogControl = pgTable('kilter_catalog_control', {
  key: text('key').primaryKey(),
  ownerId: text('owner_id').notNull(),
  leaseUntil: timestamp('lease_until', { withTimezone: true }).notNull(),
});

/** A watermark certifies complete durable coverage, never individual climb dates. */
export const kilterCatalogCheckpoints = pgTable('kilter_catalog_checkpoints', {
  scopeKey: text('scope_key').primaryKey(),
  mappingVersion: text('mapping_version').notNull(),
  baselineStartedAt: timestamp('baseline_started_at', { withTimezone: true }),
  baselineCompletedAt: timestamp('baseline_completed_at', { withTimezone: true }),
  confirmedThrough: timestamp('confirmed_through', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Replayable delta rows whose geometry/identity needs operator reconciliation. */
export const kilterCatalogDeferred = pgTable(
  'kilter_catalog_deferred',
  {
    sourceUuid: text('source_uuid').primaryKey(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    reason: text('reason').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [check('kilter_catalog_deferred_lower_uuid', sql`${table.sourceUuid} = lower(${table.sourceUuid})`)],
);

// Structural copy of the wire statistic; the database package cannot depend on
// the provider importer. Keep upstream values here before quality conversion.
export type KilterCatalogSourceStatPayload = {
  climbUuid: string;
  angle: number;
  ascentCount: number;
  currentDifficultyId: number | null;
  difficultyAverage: number | null;
  qualityAverage: number | null;
  faUsername: string | null;
  faAt: string | null;
};

/** Absolute contributions, deduplicated across overlapping product layouts. */
export const kilterCatalogSourceStats = pgTable(
  'kilter_catalog_source_stats',
  {
    sourceUuid: text('source_uuid').notNull(),
    angle: integer('angle').notNull(),
    canonicalUuid: text('canonical_uuid').notNull(),
    payload: jsonb('payload').$type<KilterCatalogSourceStatPayload>().notNull(),
    scopeKey: text('scope_key').default('').notNull(),
    generation: text('generation').default('').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceUuid, table.angle] }),
    check('kilter_catalog_source_stats_lower_uuid', sql`${table.sourceUuid} = lower(${table.sourceUuid})`),
    index('kilter_catalog_source_stats_canonical_idx').on(table.canonicalUuid, table.angle),
  ],
);
