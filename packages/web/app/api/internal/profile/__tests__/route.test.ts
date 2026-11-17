// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const control = vi.hoisted(() => ({ session: vi.fn(), select: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/auth/admitted-session.server', () => ({ getAdmittedServerSession: control.session }));
vi.mock('@/app/lib/db/schema', () => ({
  userProfiles: { table: 'userProfiles', userId: 'userProfiles.userId' },
  users: { table: 'users', id: 'users.id' },
  userCredentials: { table: 'userCredentials', userId: 'userCredentials.userId' },
  accounts: { table: 'accounts', userId: 'accounts.userId', provider: 'accounts.provider' },
}));

const rowsByTable: Record<string, unknown[]> = {
  userProfiles: [],
  users: [{ id: 'owner-a', email: 'owner@example.test', name: 'Climber', image: null }],
  userCredentials: [{ userId: 'owner-a' }],
  accounts: [{ provider: 'google' }],
};

vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    select: (...fields: unknown[]) => {
      control.select(...fields);
      return {
        from: (table: { table: string }) => ({
          where: () => {
            const rows = rowsByTable[table.table];
            return Object.assign(Promise.resolve(rows), { limit: async () => rows });
          },
        }),
      };
    },
  }),
}));

import { GET } from '../route';

function read(expectedViewer?: string) {
  return GET(
    new NextRequest('https://www.boardsesh.test/api/internal/profile', {
      headers: expectedViewer === undefined ? {} : { 'X-Boardsesh-Expected-Viewer': expectedViewer },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  control.session.mockResolvedValue({ user: { id: 'owner-a' }, authSessionId: 'login-a' });
});

describe('GET /api/internal/profile', () => {
  it('returns the signed-in account to the tab that names it', async () => {
    const response = await read('owner-a:login-a');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'owner-a', hasPassword: true, linkedProviders: ['google'] });
  });

  it.each([
    ['another account', 'owner-b:login-b'],
    ['another login of the same account', 'owner-a:login-older'],
    ['a signed-out tab', 'anonymous'],
  ])('answers 409 without reading anything when the tab shows %s', async (_label, expected) => {
    const response = await read(expected);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'viewer_changed', error: 'Reload this page.' });
    expect(control.select).not.toHaveBeenCalled();
  });

  // The OpenAPI document lists this route for any session holder, and an old tab sends no header.
  it('still answers a request that names no viewer', async () => {
    const response = await read();
    expect(response.status).toBe(200);
    expect(control.select).toHaveBeenCalled();
  });

  it('answers 401 to a signed-out request that names nobody', async () => {
    control.session.mockResolvedValue(null);
    const response = await read();
    expect(response.status).toBe(401);
    expect(control.select).not.toHaveBeenCalled();
  });
});
