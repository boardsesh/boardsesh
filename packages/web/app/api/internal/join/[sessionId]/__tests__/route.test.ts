// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * Where a session invite opened in a browser sends the visitor. A named path
 * (`/b/<slug>`) names its wall, so the route must redirect to the path the
 * backend's `session` read projects for this visitor, never the raw row: that
 * handed the slug of a private wall to anyone holding a session id (#7013).
 */

vi.mock('server-only', () => ({}));

const SESSION_ID = '5b1f0c2e-8d3a-4e6f-9a21-5c0d9e8f7a61';
const mocks = vi.hoisted(() => ({
  storedPath: '' as string | null,
  /** What the board-by-slug read finds, when the route falls back to it. */
  board: null as null | { boardType: string; layoutId: number; sizeId: number; setIds: string; angle: number },
  graphql: vi.fn(),
  token: vi.fn(),
}));

vi.mock('@/app/lib/db/db', async () => {
  const schema = await import('@/app/lib/db/schema');
  return {
    dbz: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => {
              if (table === schema.boardSessions) return [{ id: SESSION_ID, boardPath: mocks.storedPath }];
              return mocks.board ? [mocks.board] : [];
            },
          }),
        }),
      }),
    },
  };
});
vi.mock('@/app/lib/graphql/server-graphql', () => ({ executeAuthenticatedGraphQL: mocks.graphql }));
vi.mock('@/app/lib/auth/server-auth', () => ({ getServerAuthToken: mocks.token }));

import { GET } from '../route';

async function redirectFor(): Promise<string | null> {
  const response = await GET(new Request(`https://boardsesh.com/api/internal/join/${SESSION_ID}`), {
    params: Promise.resolve({ sessionId: SESSION_ID }),
  });
  return response.headers.get('location');
}

describe('GET /api/internal/join/[sessionId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.board = null;
    mocks.token.mockResolvedValue('visitor-token');
  });

  it('redirects to the path the backend projects for this visitor, not the stored slug', async () => {
    mocks.storedPath = '/b/marcos-private-garage/40';
    mocks.graphql.mockResolvedValue({ session: { boardPath: '/kilter/1/10/1,20/40' } });

    const location = await redirectFor();

    expect(location).toBe('https://boardsesh.com/kilter/1/10/1,20/40/list');
    expect(location).not.toContain('marcos-private-garage');
    // Asked as the visitor, about this session.
    expect(mocks.graphql).toHaveBeenCalledWith(expect.anything(), { sessionId: SESSION_ID }, 'visitor-token');
  });

  it('keeps the named path when the backend names the wall to this visitor', async () => {
    mocks.storedPath = '/b/rocodromo-norte/40';
    mocks.graphql.mockResolvedValue({ session: { boardPath: '/b/rocodromo-norte/40' } });
    expect(await redirectFor()).toBe('https://boardsesh.com/b/rocodromo-norte/40/list');
  });

  it("lands a dormant session's invite on the wall's geometry, never its slug", async () => {
    // A dormant session has an empty live roster, so `session` answers null.
    mocks.storedPath = '/b/marcos-private-garage/45';
    mocks.board = { boardType: 'kilter', layoutId: 1, sizeId: 10, setIds: '1,20', angle: 40 };
    mocks.graphql.mockResolvedValue({ session: null });
    expect(await redirectFor()).toBe('https://boardsesh.com/kilter/1/10/1,20/45/list');

    mocks.graphql.mockRejectedValue(new Error('backend down'));
    expect(await redirectFor()).toBe('https://boardsesh.com/kilter/1/10/1,20/45/list');
  });

  it('sends the visitor home only when no live board holds the slug', async () => {
    mocks.storedPath = '/b/marcos-private-garage/40';
    mocks.graphql.mockResolvedValue({ session: null });
    expect(await redirectFor()).toBe('https://boardsesh.com/');
  });

  it('uses a positional path as stored, without asking the backend', async () => {
    mocks.storedPath = '/kilter/1/10/1,20/35';
    expect(await redirectFor()).toBe('https://boardsesh.com/kilter/1/10/1,20/35/list');
    expect(mocks.graphql).not.toHaveBeenCalled();
  });
});
