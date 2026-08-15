import 'server-only';
import { and, desc, eq, exists } from 'drizzle-orm';
import { dbzRead } from '@/app/lib/db/db';
import { playlistClimbs, playlists } from '@/app/lib/db/schema';
import type { PlaylistSitemapRow } from './playlist-entries';
import { MAX_ITEMS_PER_SHARD } from './sitemap-xml';

/**
 * Public playlists with at least one climb, newest first, hard-capped at the
 * per-shard item budget. When the result length equals the budget the shard is
 * full and needs splitting into `playlists-1.xml` / `playlists-2.xml` — we log
 * rather than silently truncate the tail.
 */
export async function fetchPlaylistSitemapRows(): Promise<PlaylistSitemapRow[]> {
  const rows = await dbzRead
    .select({ uuid: playlists.uuid, updatedAt: playlists.updatedAt })
    .from(playlists)
    .where(
      and(
        eq(playlists.isPublic, true),
        exists(
          dbzRead
            .select({ playlistId: playlistClimbs.playlistId })
            .from(playlistClimbs)
            .where(eq(playlistClimbs.playlistId, playlists.id)),
        ),
      ),
    )
    .orderBy(desc(playlists.updatedAt), playlists.uuid)
    .limit(MAX_ITEMS_PER_SHARD);

  if (rows.length === MAX_ITEMS_PER_SHARD) {
    console.warn(
      `[sitemap] playlists shard hit its ${MAX_ITEMS_PER_SHARD}-item budget — split it into paged shards before the tail goes missing.`,
    );
  }

  return rows;
}
