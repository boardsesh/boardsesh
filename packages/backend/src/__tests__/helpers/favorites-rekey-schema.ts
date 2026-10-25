import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import { db } from '../../db/client';

// The favorites re-key migration (#2637), read from disk so integration tests
// run the exact SQL production applies.
const favoritesRekeyMigration = readFileSync(
  new URL('../../../../db/drizzle/0280_favorites_key_by_climb_uuid.sql', import.meta.url),
  'utf8',
);

/**
 * Put the worker database's favorites table back in its pre-migration shape:
 * the four-column unique key, no archive, and the composite-only deletion
 * trigger. schema-sql.ts builds the post-migration shape.
 */
export async function restoreLegacyFavoriteSchema(): Promise<void> {
  await db.execute(sql`DROP INDEX IF EXISTS public.unique_user_favorite`);
  await db.execute(sql`DROP INDEX IF EXISTS public.unique_user_favorite_legacy`);
  await db.execute(sql`DROP INDEX IF EXISTS public.user_favorites_climb_idx`);
  await db.execute(sql`DROP TABLE IF EXISTS public.user_favorites_dedup_backup_0194`);
  await db.execute(sql`ALTER TABLE public.user_favorites ALTER COLUMN board_name DROP DEFAULT`);
  await db.execute(sql`ALTER TABLE public.user_favorites ALTER COLUMN angle DROP DEFAULT`);
  await db.execute(sql`
    CREATE UNIQUE INDEX unique_user_favorite
    ON public.user_favorites (user_id, board_name, climb_uuid, angle)
  `);
  await db.execute(sql`
    CREATE INDEX user_favorites_climb_idx ON public.user_favorites (climb_uuid)
  `);
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION public.log_deletion_favorites() RETURNS TRIGGER AS $$
    BEGIN
      INSERT INTO sync_deletions (table_name, record_id, user_id)
      VALUES (TG_TABLE_NAME,
              OLD.board_name || ':' || OLD.climb_uuid || ':' || OLD.angle::text,
              OLD.user_id);
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;
  `);
}

export async function runFavoritesRekeyMigration(client: postgres.Sql | postgres.TransactionSql): Promise<void> {
  for (const statement of favoritesRekeyMigration.split('--> statement-breakpoint')) {
    const trimmedStatement = statement.trim();
    if (trimmedStatement.length > 0) {
      await client.unsafe(trimmedStatement);
    }
  }
}

export async function ensureRekeyedFavoriteSchema(client: postgres.Sql): Promise<void> {
  const [archive] = await client`
    SELECT to_regclass('public.user_favorites_dedup_backup_0194') IS NOT NULL AS present
  `;
  if (!archive?.present) {
    // Recover the precise pre-0280 index expected by the migration after a
    // deliberately interrupted test run. The worker DB is PR-owned and this
    // helper restores its current schema by running the real migration below.
    await client.unsafe('CREATE INDEX IF NOT EXISTS user_favorites_climb_idx ON public.user_favorites (climb_uuid)');
    await client.begin(async (transaction) => runFavoritesRekeyMigration(transaction));
  }
}
