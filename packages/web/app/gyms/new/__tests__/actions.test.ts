import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ token: vi.fn(), request: vi.fn(), revalidate: vi.fn() }));
vi.mock('next/cache', () => ({ revalidateTag: mocks.revalidate }));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken: mocks.token }));
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL: mocks.request }));
const { refreshGymDirectory } = await import('../actions');
const gymUuid = '87f2c9c4-bbd9-4510-8ed5-f9aad68095dd';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.token.mockResolvedValue('token');
  mocks.request.mockResolvedValue({ gym: { uuid: gymUuid, canEdit: true } });
});

describe('gym directory cache refresh', () => {
  it('expires directory results and facet counts after checking edit access', async () => {
    expect(await refreshGymDirectory(gymUuid)).toBe(true);
    expect(mocks.revalidate.mock.calls).toEqual([
      ['gym-directory', { expire: 0 }],
      ['gym-directory-facet-counts', { expire: 0 }],
    ]);
  });

  it('never expires caches for anonymous, malformed or unauthorized requests', async () => {
    mocks.token.mockResolvedValueOnce(null);
    expect(await refreshGymDirectory(gymUuid)).toBe(false);
    expect(await refreshGymDirectory('bad-uuid')).toBe(false);
    mocks.request.mockResolvedValueOnce({ gym: { canEdit: false } });
    expect(await refreshGymDirectory(gymUuid)).toBe(false);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('reports cache failure without throwing away a successful mutation', async () => {
    mocks.request.mockRejectedValueOnce(new Error('backend temporarily unavailable'));
    expect(await refreshGymDirectory(gymUuid)).toBe(false);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
