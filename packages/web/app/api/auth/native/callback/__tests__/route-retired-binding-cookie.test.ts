// @vitest-environment node
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

// The admitted-session reader and the transfer signer run for real here. Only the Next request store and NextAuth's
// session callback stand in, and the backend authority is a local HTTP server.
const controls = vi.hoisted(() => ({
  cookies: [] as { name: string; value: string }[],
  session: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => controls.cookies }) }));
vi.mock('next-auth/next', () => ({ getServerSession: (...parameters: unknown[]) => controls.session(...parameters) }));
vi.mock('@/app/lib/auth/auth-options', () => ({
  authOptions: { cookies: { sessionToken: { name: '__Secure-next-auth.session-token', options: {} } } },
}));

import { GET } from '../route';

const fixtureSecret = 'native-callback-retired-cookie-secret';
const fixtureOwner = 'retired-cookie-owner';
const authorityBearers: string[] = [];
let authority: Server;
let authorityUrl: string;
let sessionCookie: string;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

beforeAll(async () => {
  authority = createServer((request, response) => {
    void readBody(request).then(() => {
      authorityBearers.push(request.headers.authorization ?? '');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: { authenticatedUserId: fixtureOwner } }));
    });
  });
  await new Promise<void>((resolve) => authority.listen(0, '127.0.0.1', resolve));
  authorityUrl = `ws://127.0.0.1:${(authority.address() as AddressInfo).port}/graphql`;
});
afterAll(async () => {
  authority.closeAllConnections();
  await new Promise<void>((resolve) => authority.close(() => resolve()));
});

beforeEach(async () => {
  vi.stubEnv('NEXTAUTH_SECRET', fixtureSecret);
  vi.stubEnv('NEXTAUTH_URL', 'https://www.boardsesh.com');
  vi.stubEnv('BACKEND_INTERNAL_URL', authorityUrl);
  vi.stubEnv('CURRENT_STORE_WEB_CREDENTIAL_PROOF_MODE', '');
  authorityBearers.length = 0;
  controls.session.mockReset().mockResolvedValue({
    user: { id: fixtureOwner },
    authSessionId: 'retired-cookie-login',
    authGeneration: 4,
    expires: '2099-01-01T00:00:00.000Z',
  });
  sessionCookie = await encode({ secret: fixtureSecret, token: { sub: fixtureOwner }, maxAge: 60 });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** One browser request: the same cookies reach the route and the Next request store. */
async function callback(extraCookies: { name: string; value: string }[]): Promise<URL> {
  controls.cookies = [{ name: '__Secure-next-auth.session-token', value: sessionCookie }, ...extraCookies];
  const cookieHeader = controls.cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
  const response = await GET(
    new NextRequest('https://www.boardsesh.com/api/auth/native/callback?next=/settings', {
      headers: { cookie: cookieHeader },
    }),
  );
  const deepLink = (await response.text()).match(/window\.location\.href=(".*?")/);
  if (!deepLink) throw new Error('No deep link in the callback page');
  return new URL(JSON.parse(deepLink[1]) as string);
}

describe('native callback with the selected handoff deleted', () => {
  it('signs the legacy transfer from an admitted NextAuth session', async () => {
    const deepLink = await callback([]);

    expect(deepLink.searchParams.get('error')).toBeNull();
    expect(deepLink.searchParams.get('next')).toBe('/settings');
    const transfer = deepLink.searchParams.get('transferToken') ?? '';
    const claims = JSON.parse(Buffer.from(transfer.split('.')[0], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(claims).toMatchObject({ userId: fixtureOwner, gen: 4, authSessionId: 'retired-cookie-login' });
    expect(authorityBearers).toEqual([`Bearer ${sessionCookie}`, `Bearer ${sessionCookie}`]);
  });

  // #7594: a cookie left over from the staged browser binding no longer blocks
  // the legacy session.
  it.each(['__Host-boardsesh.browser-binding', '__Host-boardsesh.browser-binding.0'])(
    'signs the legacy transfer when the browser still carries a retired %s cookie',
    async (retiredCookie) => {
      const deepLink = await callback([{ name: retiredCookie, value: 'retired' }]);

      expect(deepLink.searchParams.get('error')).toBeNull();
      expect(deepLink.searchParams.get('transferToken')).toBeTruthy();
      expect(authorityBearers).toEqual([`Bearer ${sessionCookie}`, `Bearer ${sessionCookie}`]);
    },
  );
});
