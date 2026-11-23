import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { select, where, limit, sitemapRows } = vi.hoisted(() => {
  const sitemapRows: Array<{ slug: string; updatedAt: Date }> = [];
  const limit = vi.fn((_rowLimit: number) => Promise.resolve(sitemapRows));
  const where = vi.fn((_condition: unknown) => ({ orderBy: () => ({ limit }) }));
  const select = vi.fn((_projection: Record<string, unknown>) => ({ from: () => ({ where }) }));
  return { select, where, limit, sitemapRows };
});

vi.mock('../db/client', () => ({ db: { select } }));

import { MAX_GYM_SITEMAP_ENTRIES, publicGymSitemap } from '../graphql/resolvers/social/gym-sitemap';

describe('public gym sitemap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sitemapRows.length = 0;
  });

  it('selects only canonical public listed venues with usable slugs and coordinates', async () => {
    await publicGymSitemap();
    const query = new PgDialect().sqlToQuery(where.mock.calls[0][0] as SQL);
    expect(query.sql).toContain('"gyms"."is_public" = $1');
    expect(query.sql).toContain('"gyms"."is_listed" = $2');
    expect(query.params).toEqual([true, true, '']);
    expect(query.sql).toContain('"gyms"."deleted_at" is null');
    expect(query.sql).toContain('"gyms"."merged_into_gym_id" is null');
    expect(query.sql).toContain('"gyms"."slug" is not null');
    expect(query.sql).toContain('"gyms"."slug" <> $3');
    expect(query.sql).toContain('"gyms"."latitude" BETWEEN -90 AND 90');
    expect(query.sql).toContain('"gyms"."longitude" BETWEEN -180 AND 180');
    expect(Object.keys(select.mock.calls[0][0])).toEqual(['slug', 'updatedAt']);
    expect(limit).toHaveBeenCalledWith(MAX_GYM_SITEMAP_ENTRIES + 1);
  });

  it('uses the stored content timestamp and accepts exactly the venue budget', async () => {
    const updatedAt = new Date('2026-10-15T14:30:00Z');
    sitemapRows.push(
      ...Array.from({ length: MAX_GYM_SITEMAP_ENTRIES }, (_, index) => ({
        slug: `gym-${index}`,
        updatedAt,
      })),
    );
    const entries = await publicGymSitemap();
    expect(entries).toHaveLength(MAX_GYM_SITEMAP_ENTRIES);
    expect(entries[0]).toEqual({ slug: 'gym-0', updatedAt: '2026-10-15T14:30:00.000Z' });
  });

  it('rejects overflow rather than silently dropping eligible gyms', async () => {
    sitemapRows.push(
      ...Array.from({ length: MAX_GYM_SITEMAP_ENTRIES + 1 }, (_, index) => ({
        slug: `gym-${index}`,
        updatedAt: new Date('2026-10-15T14:30:00Z'),
      })),
    );
    await expect(publicGymSitemap()).rejects.toThrow('exceeds its venue budget');
  });

  it('propagates database failures so sitemap publication can fail closed', async () => {
    limit.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(publicGymSitemap()).rejects.toThrow('database unavailable');
  });
});
