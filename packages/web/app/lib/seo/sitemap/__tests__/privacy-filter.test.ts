import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { drizzle } from 'drizzle-orm/postgres-js';
const mocks = vi.hoisted(() => {
  const where = vi.fn();
  const from = vi.fn(() => ({ where }));
  return { where, select: vi.fn(() => ({ from })) };
});
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/db', () => ({ dbz: { select: mocks.select, selectDistinct: mocks.select } }));
import { buildSitemapClimbRecheckQuery, filterPublicSitemapItems } from '../privacy-filter';
const uuid = 'b08974a7-f6f2-41b9-b6d6-059cd6b2e33f';
const candidate = { path: `/kilter/original/12x12/sets/40/view/problem-${uuid}` };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sitemap publication revocation', () => {
  it('rechecks cached candidates on every rendering request', async () => {
    mocks.where.mockResolvedValueOnce([{ identifier: uuid, boardType: 'kilter' }]).mockResolvedValueOnce([]);
    expect(await filterPublicSitemapItems([candidate], 'climbs')).toEqual([candidate]);
    expect(await filterPublicSitemapItems([candidate], 'climbs')).toEqual([]);
    expect(mocks.where).toHaveBeenCalledTimes(2);
  });
  it('does not let a same-UUID climb on another board authorize a URL', async () => {
    mocks.where.mockResolvedValue([{ identifier: uuid, boardType: 'tension' }]);
    expect(await filterPublicSitemapItems([candidate], 'climbs')).toEqual([]);
  });
  it('drops a formerly public playlist and a setter without visible climbs', async () => {
    mocks.where.mockResolvedValue([]);
    expect(await filterPublicSitemapItems([{ path: `/playlists/${uuid}` }], 'playlists')).toEqual([]);
    expect(await filterPublicSitemapItems([{ path: '/setter/private-setter' }], 'setters')).toEqual([]);
  });
  it('keeps static marketing and catalog configuration URLs without a database read', async () => {
    const candidates = [{ path: '/about' }];
    expect(await filterPublicSitemapItems(candidates, 'static')).toBe(candidates);
    expect(mocks.select).not.toHaveBeenCalled();
  });
});

// The rendered SQL of the real builder: a drizzle instance with no client
// behind it never touches a connection.
describe('the climb and setter recheck predicate', () => {
  const db = drizzle({} as never);

  for (const kind of ['climbs', 'setters'] as const) {
    const rendered = buildSitemapClimbRecheckQuery(db, kind, [uuid]).toSQL();
    const sql = rendered.sql.toLowerCase().replace(/\s+/g, ' ');

    it(`${kind}: drops drafts, unlisted and hidden climbs, and climbs on a private spray wall`, () => {
      expect(sql).toMatch(/"board_climbs"\."is_listed" = \$\d+/);
      expect(sql).toMatch(/"board_climbs"\."is_draft" = \$\d+/);
      expect(sql).toMatch(/"board_climbs"\."is_hidden" = \$\d+/);
      expect(rendered.params).toEqual(expect.arrayContaining([true, false]));
      // The spray-wall predicate is the wall's own rule and stays.
      expect(sql).toContain('spray_walls');
    });

    it(`${kind}: keeps a private account's published climb, consulting no account or item privacy`, () => {
      // A published, listed climb is public to everyone, whoever set it.
      expect(sql).not.toContain('content_privacy');
      expect(sql).not.toContain('user_profiles');
      expect(sql).not.toContain('is_private');
    });
  }
});
