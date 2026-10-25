// @vitest-environment node
import { describe, expect, it, vi } from 'vite-plus/test';
import { SSR_BACKEND_FETCH_TIMEOUT_MS } from '@/app/lib/ssr-fetch-deadline';

vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken: vi.fn(async () => undefined) }));
vi.mock('@/app/lib/graphql/server-graphql', () => ({
  executeAuthenticatedGraphQL: vi.fn(async () => ({ recentBetaLinks: [] })),
}));

const { getRecentBetaLinks } = await import('../server-recent-beta-links');
const { executeAuthenticatedGraphQL } = await import('@/app/lib/graphql/server-graphql');

describe('getRecentBetaLinks', () => {
  it('reads with the 3 s homepage ceiling', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    await getRecentBetaLinks();

    const signal = vi.mocked(executeAuthenticatedGraphQL).mock.calls[0]?.[3];
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(SSR_BACKEND_FETCH_TIMEOUT_MS);
    timeoutSpy.mockRestore();
  });
});
