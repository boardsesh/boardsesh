import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
const mocks = vi.hoisted(() => {
  const where = vi.fn();
  const from = vi.fn(() => ({ where }));
  return { where, select: vi.fn(() => ({ from })) };
});
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/db', () => ({ dbz: { select: mocks.select, selectDistinct: mocks.select } }));
import { filterPublicSitemapItems } from '../privacy-filter';
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
