import { describe, expect, it } from 'vite-plus/test';
import { gyms, users } from '@boardsesh/db/schema';
import { db } from '../db/client';
import { publicGymSitemap } from '../graphql/resolvers/social/gym-sitemap';

describe('gym sitemap venue eligibility in PostgreSQL', () => {
  it('excludes private, unlisted, merged, slugless and invalid-location gyms', async () => {
    const ownerId = 'gym-sitemap-test-owner';
    await db.insert(users).values({ id: ownerId, name: 'Sitemap owner', email: 'gym-sitemap@example.test' });
    const base = {
      ownerId,
      name: 'Sitemap test venue',
      isPublic: true,
      isListed: true,
      latitude: 52.37,
      longitude: 4.89,
      updatedAt: new Date('2026-10-15T14:30:00Z'),
    };
    const [canonical] = await db
      .insert(gyms)
      .values({
        ...base,
        uuid: 'sitemap-canonical',
        slug: 'sitemap-canonical',
      })
      .returning();

    const excluded: Array<Partial<typeof gyms.$inferInsert>> = [
      { isPublic: false },
      { isListed: false },
      { deletedAt: new Date('2026-10-16T00:00:00Z') },
      // Even an inconsistent live alias must not become a sitemap URL.
      { mergedIntoGymId: canonical.id },
      { slug: null },
      { slug: '' },
      { latitude: null },
      { longitude: null },
      { latitude: Number.NaN },
      { longitude: Number.POSITIVE_INFINITY },
      { latitude: Number.NEGATIVE_INFINITY },
      { latitude: 90.01 },
      { latitude: -90.01 },
      { longitude: 180.01 },
      { longitude: -180.01 },
    ];
    await db.insert(gyms).values(
      excluded.map((overrides, index) => ({
        ...base,
        uuid: `sitemap-excluded-${index}`,
        slug: `sitemap-excluded-${index}`,
        ...overrides,
      })),
    );

    const entries = await publicGymSitemap();
    expect(entries.filter((entry) => entry.slug.startsWith('sitemap-'))).toEqual([
      { slug: 'sitemap-canonical', updatedAt: '2026-10-15T14:30:00.000Z' },
    ]);
  });
});
