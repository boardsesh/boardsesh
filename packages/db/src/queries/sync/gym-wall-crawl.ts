import { and, asc, isNull, like, lt, or, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { locationSyncGymSources } from '../../schema/app/location-sync';

type DrizzleDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * How long a gym's walls stay fresh before the crawl will read them again.
 *
 * Gyms reconfigure a wall rarely — a re-layout or a swapped controller — so a
 * weekly re-read is plenty, and it is what makes the crawl self-throttling:
 * once the fleet is covered, most cycles find nothing eligible and cost nothing.
 * Matches the cadence of the existing weekly cursors in `weekly-gate.ts`.
 */
export const GYM_WALL_RECRAWL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The gym source keys most in need of a wall read for one provider, never-read
 * first and then oldest-read, capped at `limit`.
 *
 * Ordering is the crawl's entire resume mechanism: there is no stored position,
 * so a restart, a redeploy or a second daemon instance simply asks again and
 * gets whatever is stalest right now. That also means two instances racing
 * mostly re-read the same handful rather than corrupting anything.
 *
 * Source keys are `{provider}:{pin id}` for a gym, so the provider prefix is
 * matched with a `LIKE` — board source keys for extra walls carry a further
 * `:{wall uuid}` suffix and are not gym rows, so they never appear in this
 * table at all.
 */
export async function findGymsDueForWallCrawl(
  db: DrizzleDb,
  options: { provider: string; limit: number; recrawlIntervalMs?: number },
): Promise<string[]> {
  const recrawlIntervalMs = options.recrawlIntervalMs ?? GYM_WALL_RECRAWL_INTERVAL_MS;
  if (options.limit <= 0) return [];

  const rows = await db
    .select({ sourceKey: locationSyncGymSources.sourceKey })
    .from(locationSyncGymSources)
    .where(
      and(
        like(locationSyncGymSources.sourceKey, `${options.provider}:%`),
        or(
          isNull(locationSyncGymSources.wallsCrawledAt),
          lt(
            locationSyncGymSources.wallsCrawledAt,
            sql`(now() at time zone 'utc') - make_interval(secs => ${recrawlIntervalMs / 1000}::double precision)`,
          ),
        ),
      ),
    )
    // NULLS FIRST is the default for ASC in Postgres, but state it: "never read"
    // must outrank "read longest ago" or a first crawl never finishes while old
    // rows keep aging past the floor.
    .orderBy(sql`${locationSyncGymSources.wallsCrawledAt} ASC NULLS FIRST`, asc(locationSyncGymSources.sourceKey))
    .limit(options.limit);

  return rows.map((row) => row.sourceKey);
}

/**
 * Stamp the gyms whose walls were just read. Called with the keys the crawl
 * actually reached, including ones that came back empty — a gym with no walls
 * is a successful read, and re-reading it every cycle would starve the rest of
 * the fleet.
 *
 * Failed reads are deliberately NOT stamped, so they stay at the front of the
 * queue and are retried next cycle.
 */
export async function markGymWallsCrawled(db: DrizzleDb, sourceKeys: string[]): Promise<void> {
  if (sourceKeys.length === 0) return;
  await db
    .update(locationSyncGymSources)
    .set({ wallsCrawledAt: sql`(now() at time zone 'utc')` })
    .where(sql`${locationSyncGymSources.sourceKey} = ANY(${sourceKeys})`);
}

/**
 * The subset of `sourceKeys` that already carries real wall data.
 *
 * The cheap hourly location sync publishes a guessed default config for any gym
 * it cannot read. Without this check it would overwrite an enriched row back to
 * the guess on its very next run, undoing the crawl an hour later.
 */
export async function findCrawledGymSourceKeys(db: DrizzleDb, sourceKeys: string[]): Promise<Set<string>> {
  if (sourceKeys.length === 0) return new Set();
  const rows = await db
    .select({ sourceKey: locationSyncGymSources.sourceKey })
    .from(locationSyncGymSources)
    .where(
      and(
        sql`${locationSyncGymSources.sourceKey} = ANY(${sourceKeys})`,
        sql`${locationSyncGymSources.wallsCrawledAt} IS NOT NULL`,
      ),
    );
  return new Set(rows.map((row) => row.sourceKey));
}
