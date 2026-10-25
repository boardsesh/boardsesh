import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));

const executeAuthenticatedGraphQL = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL }));

const { fetchGymBySlug } = await import('../fetch-gym-by-slug');

describe('fetchGymBySlug', () => {
  it('returns null for a real miss so the page can 404', async () => {
    executeAuthenticatedGraphQL.mockResolvedValue({ gymBySlug: null });
    expect(await fetchGymBySlug('no-such-gym', undefined)).toBeNull();
  });

  it('returns null for a non-deadline failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    executeAuthenticatedGraphQL.mockRejectedValue(new Error('boom'));
    expect(await fetchGymBySlug('broken-gym', undefined)).toBeNull();
  });

  it('rethrows a deadline so a slow backend is a 5xx, not a 404', async () => {
    executeAuthenticatedGraphQL.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await expect(fetchGymBySlug('slow-gym', undefined)).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
