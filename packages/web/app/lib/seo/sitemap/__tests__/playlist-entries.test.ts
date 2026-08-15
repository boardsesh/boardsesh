import { describe, expect, it, vi } from 'vite-plus/test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { playlistRowsToItems } from '../playlist-entries';
import { MAX_ITEMS_PER_SHARD } from '../sitemap-xml';

vi.mock('server-only', () => ({}));
// A drizzle instance with no client behind it: building and rendering a query
// never touches the connection, and the test must not need a database.
vi.mock('@/app/lib/db/db', () => ({ dbzRead: drizzle({} as never) }));
// Module scope calls `unstable_cache` on import; the caching behaviour itself is
// playlist-query.test.ts's subject, not this file's.
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));

const { buildPlaylistSitemapQuery } = await import('../playlist-query');

describe('playlistRowsToItems', () => {
  it('maps rows to /playlists/{uuid} with the real updated_at', () => {
    const items = playlistRowsToItems([
      { uuid: 'abc-123', updatedAt: new Date('2026-04-30T10:00:00.000Z') },
      { uuid: 'def-456', updatedAt: new Date('2026-01-02T00:00:00.000Z') },
    ]);

    expect(items[0].path).toBe('/playlists/abc-123');
    expect(items[0].lastModified).toEqual(new Date('2026-04-30T10:00:00.000Z'));
    expect(items[1].lastModified).toEqual(new Date('2026-01-02T00:00:00.000Z'));
  });

  it('encodes a uuid that would otherwise need escaping in a URL', () => {
    expect(playlistRowsToItems([{ uuid: 'a b&c', updatedAt: new Date(0) }])[0].path).toBe('/playlists/a%20b%26c');
  });
});

describe('the playlists query', () => {
  // Renders the SQL drizzle actually produces rather than grepping the source
  // for the predicate we hope is there: a restated predicate is a tautology, and
  // a substring grep false-reds on a harmless refactor.
  // The handle is a parameter now, so the query can run inside the transaction
  // its `SET LOCAL statement_timeout` needs. Rendering it off a client-less
  // drizzle instance is unchanged.
  const { sql, params } = buildPlaylistSitemapQuery(drizzle({} as never)).toSQL();
  const normalised = sql.toLowerCase().replace(/\s+/g, ' ');

  it('filters to public playlists', () => {
    expect(normalised).toMatch(/"is_public" = \$\d+/);
    expect(params).toContain(true);
  });

  it('requires at least one climb via an exists-correlated subquery', () => {
    expect(normalised).toMatch(
      /exists \(select .*from "playlist_climbs" where "playlist_climbs"\."playlist_id" = "playlists"\."id"\)/,
    );
  });

  it('orders newest first and limits to the per-shard item budget', () => {
    expect(normalised).toMatch(/order by "playlists"\."updated_at" desc/);
    expect(normalised).toMatch(/limit \$\d+/);
    expect(params).toContain(MAX_ITEMS_PER_SHARD);
    expect(MAX_ITEMS_PER_SHARD).toBe(11_250);
  });
});
