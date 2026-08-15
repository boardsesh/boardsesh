import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { playlistRowsToItems } from '../playlist-entries';
import { MAX_ITEMS_PER_SHARD } from '../sitemap-xml';

describe('playlistRowsToItems', () => {
  it('maps rows to /playlists/{uuid} with the real updated_at', () => {
    const items = playlistRowsToItems([
      { uuid: 'abc-123', updatedAt: new Date('2026-04-30T10:00:00.000Z') },
      { uuid: 'def-456', updatedAt: null },
    ]);

    expect(items[0].path).toBe('/playlists/abc-123');
    expect(items[0].lastModified).toEqual(new Date('2026-04-30T10:00:00.000Z'));
    expect(items[1].lastModified).toBeNull();
  });

  it('encodes a uuid that would otherwise need escaping in a URL', () => {
    expect(playlistRowsToItems([{ uuid: 'a b&c', updatedAt: null }])[0].path).toBe('/playlists/a%20b%26c');
  });
});

describe('the playlists query', () => {
  // Mutation test: the filters and the LIMIT are the shard's whole contract —
  // drop one and private/climbless playlists get submitted, or the tail is
  // silently truncated.
  const source = readFileSync(join(import.meta.dirname, '..', 'playlist-query.ts'), 'utf8');

  it('filters to public playlists that have climbs', () => {
    expect(source).toContain('eq(playlists.isPublic, true)');
    expect(source).toContain('exists(');
    expect(source).toContain('playlistClimbs.playlistId, playlists.id');
  });

  it('limits to the per-shard item budget', () => {
    expect(source).toContain('.limit(MAX_ITEMS_PER_SHARD)');
    expect(MAX_ITEMS_PER_SHARD).toBe(11_250);
  });
});
