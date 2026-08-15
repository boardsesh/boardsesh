import type { SitemapItem } from './entries';

export type PlaylistSitemapRow = {
  uuid: string;
  /** `playlists.updated_at` is `notNull().defaultNow()`, so a row always has one. */
  updatedAt: Date;
};

/**
 * Public playlists that hold at least one climb. `lastModified` is the real
 * `playlists.updated_at` — the one surface in this PR that has an honest
 * content timestamp.
 */
export function playlistRowsToItems(rows: readonly PlaylistSitemapRow[]): SitemapItem[] {
  return rows.map((row) => ({
    path: `/playlists/${encodeURIComponent(row.uuid)}`,
    lastModified: row.updatedAt,
    changeFrequency: 'weekly' as const,
    priority: 0.6,
  }));
}
