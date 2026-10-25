// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Who gets a wall's photo through this route, with the real backend read in
 * the loop and only the backend itself faked.
 *
 * The view rule is the backend's (`viewerCanSeeSprayWall`, covered by the
 * backend's own tests): a signed-out read sees a public wall and an unlisted
 * one, a private wall is "not found". The fake below answers that way. What
 * this file holds the route to is its half of the deal: it asks about exactly
 * the uuid in the URL, which is the unlisted wall's capability, and it asks
 * signed out, so a browser carrying the owner's session can never turn this
 * into a read of the owner's private wall.
 */

vi.mock('server-only', () => ({}));

vi.mock('@/app/lib/observability/request-logger', () => ({
  createRequestLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/app/lib/graphql/client', () => ({ getGraphQLHttpUrl: () => 'https://backend.example/graphql' }));

vi.mock('@/app/lib/auth/rate-limiter', () => ({
  checkRateLimit: vi.fn(() => ({ limited: false, retryAfterSeconds: 0 })),
  getClientIp: vi.fn(() => '203.0.113.7'),
}));

const PUBLIC_WALL = '0144249a-3a8c-47c2-8c1e-54c0c572fe02';
const UNLISTED_WALL = '7d1f4c2e-9b3a-4e6f-8a21-5c0d9e8f7a61';
const PRIVATE_WALL = 'c3a9e1b7-2f4d-4a8c-9e6b-1d7f0a2c5e93';
/** One character off the unlisted wall's uuid: a mistyped or guessed link. */
const WRONG_UUID = '7d1f4c2e-9b3a-4e6f-8a21-5c0d9e8f7a62';

const WALLS: Record<string, { visibility: 'public' | 'unlisted' | 'private'; photo: string }> = {
  [PUBLIC_WALL]: { visibility: 'public', photo: 'https://private.example/public-wall.jpg?sig=fresh' },
  [UNLISTED_WALL]: { visibility: 'unlisted', photo: 'https://private.example/unlisted-wall.jpg?sig=fresh' },
  [PRIVATE_WALL]: { visibility: 'private', photo: 'https://private.example/private-wall.jpg?sig=fresh' },
};

type BackendCall = { uuid: unknown; headers: Headers };
const backendCalls: BackendCall[] = [];

/** `sprayWall(uuid)` as the backend answers a signed-out reader. */
async function fakeBackend(_input: unknown, init?: RequestInit): Promise<Response> {
  if (typeof init?.body !== 'string') throw new Error('expected a JSON string body');
  const body = JSON.parse(init.body) as { variables: { uuid: unknown } };
  const headers = new Headers(init?.headers);
  backendCalls.push({ uuid: body.variables.uuid, headers });

  const signedIn = headers.has('authorization') || headers.has('cookie');
  const wall = typeof body.variables.uuid === 'string' ? WALLS[body.variables.uuid] : undefined;
  const visible = wall && (wall.visibility !== 'private' || signedIn);
  const sprayWall = visible ? { currentVersion: { photo: { url: wall.photo } } } : null;
  return new Response(JSON.stringify({ data: { sprayWall } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const { GET } = await import('../route');

function request(wallUuid: string) {
  // The browser's own session rides along, as it would on an <img> request
  // from a page the owner is signed in on.
  return GET(
    new Request(`https://boardsesh.com/api/v1/spray-walls/${wallUuid}/photo`, {
      headers: { cookie: '__Secure-next-auth.session-token=owner-session', authorization: 'Bearer owner-token' },
    }),
    { params: Promise.resolve({ wall_uuid: wallUuid }) },
  );
}

beforeEach(() => {
  backendCalls.length = 0;
  vi.stubGlobal('fetch', vi.fn(fakeBackend));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/v1/spray-walls/[wall_uuid]/photo: who gets a photo', () => {
  it("redirects a public wall's photo", async () => {
    const response = await request(PUBLIC_WALL);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(WALLS[PUBLIC_WALL].photo);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it("redirects an unlisted wall's photo for its own uuid, the one its share link carries", async () => {
    const response = await request(UNLISTED_WALL);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(WALLS[UNLISTED_WALL].photo);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('404s a wrong uuid, and asks the backend about that uuid and no other', async () => {
    const response = await request(WRONG_UUID);

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(backendCalls.map((call) => call.uuid)).toEqual([WRONG_UUID]);
  });

  it("404s a private wall even when the browser carries its owner's session", async () => {
    const response = await request(PRIVATE_WALL);

    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('location')).toBeNull();
  });

  it('asks the backend signed out, whatever the browser sent', async () => {
    await request(UNLISTED_WALL);

    expect(backendCalls).toHaveLength(1);
    expect(backendCalls[0].headers.has('authorization')).toBe(false);
    expect(backendCalls[0].headers.has('cookie')).toBe(false);
  });
});
