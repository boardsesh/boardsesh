// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encode } from 'next-auth/jwt';

const controls = vi.hoisted(() => ({
  cookies: [] as { name: string; value: string }[],
  session: vi.fn(),
  // Stands in for React's per-render cache, which only exists under react-server.
  renderMemo: new Map<unknown, unknown>(),
}));
vi.mock('server-only', () => ({}));
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache:
    <Result>(compute: () => Result) =>
    () => {
      if (!controls.renderMemo.has(compute)) controls.renderMemo.set(compute, compute());
      return controls.renderMemo.get(compute) as Result;
    },
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => controls.cookies }) }));
vi.mock('next-auth/next', () => ({ getServerSession: (...parameters: unknown[]) => controls.session(...parameters) }));
vi.mock('../auth-options', () => ({
  authOptions: { cookies: { sessionToken: { name: 'next-auth.session-token', options: {} } } },
}));
vi.mock('../../backend-url', () => ({ getGraphQLHttpUrl: () => 'http://authority.invalid/graphql' }));

import { getAdmittedRawServerToken, getAdmittedServerSession } from '../admitted-session.server';

const fixtureSecret = 'local-admitted-session-render-secret';
const fetchMock = vi.fn<typeof fetch>();

beforeEach(async () => {
  vi.stubEnv('NEXTAUTH_SECRET', fixtureSecret);
  vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.com');
  vi.stubGlobal('fetch', fetchMock);
  controls.renderMemo.clear();
  controls.session.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json({ data: { authenticatedUserId: 'fixture-owner' } }));
  const credential = await encode({ secret: fixtureSecret, token: { sub: 'fixture-owner' }, maxAge: 60 });
  controls.cookies = [{ name: '__Secure-next-auth.session-token', value: credential }];
});

describe('admission within one server render', () => {
  it('asks the backend once however many times the token is read', async () => {
    const tokens = await Promise.all(Array.from({ length: 15 }, () => getAdmittedRawServerToken()));

    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares that admission with the session read, which rechecks once after its callback', async () => {
    controls.session.mockResolvedValue({ user: { id: 'fixture-owner' } });

    await Promise.all([getAdmittedRawServerToken(), getAdmittedRawServerToken()]);
    await expect(getAdmittedServerSession()).resolves.toMatchObject({ user: { id: 'fixture-owner' } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('admits again on the next render', async () => {
    await getAdmittedRawServerToken();
    controls.renderMemo.clear();
    await getAdmittedRawServerToken();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
