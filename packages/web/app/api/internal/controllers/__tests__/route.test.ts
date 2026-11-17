vi.mock('server-only', () => ({}));
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { NextRequest } from 'next/server';

const control = vi.hoisted(() => ({
  session: vi.fn(),
  insertedValues: vi.fn(),
  selected: vi.fn(),
  deleted: vi.fn(),
}));

vi.mock('@/app/lib/auth/admitted-session.server', () => ({
  getAdmittedServerSession: control.session,
}));
vi.mock('@/app/lib/auth/auth-options', () => ({ authOptions: {} }));
vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        control.insertedValues(values);
        return { returning: async () => [{ id: 'controller-1', createdAt: new Date(), ...values }] };
      },
    }),
    select: () => ({
      from: () => ({
        where: async () => {
          control.selected();
          return [];
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        control.deleted();
      },
    }),
  }),
}));

import { DELETE, GET, POST } from '../route';

const VIEWER_1 = 'user-1:login-1';
const CONTROLLER_ID = '3f0c6a8e-2f4b-4c1e-9d7a-5b6c7d8e9f01';

function request(method: string, body?: unknown, expectedViewer: string | null = VIEWER_1) {
  return new Request('http://localhost/api/internal/controllers', {
    method,
    headers: expectedViewer === null ? {} : { 'X-Boardsesh-Expected-Viewer': expectedViewer },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as unknown as NextRequest;
}

const register = (body: unknown) => POST(request('POST', body));

beforeEach(() => {
  vi.clearAllMocks();
  control.session.mockResolvedValue({ user: { id: 'user-1' }, authSessionId: 'login-1' });
});

describe('POST /api/internal/controllers', () => {
  it('stores a Spraywall key with the placeholder configuration', async () => {
    const response = await register({ name: 'Projector', boardName: 'spray' });

    expect(response.status).toBe(200);
    expect(control.insertedValues).toHaveBeenCalledWith(
      expect.objectContaining({ boardName: 'spray', layoutId: 0, sizeId: 0, setIds: '' }),
    );
  });

  // The server owns these values, so a client cannot write a config for a spray key.
  it('ignores a configuration sent with a Spraywall key', async () => {
    const response = await register({ boardName: 'spray', layoutId: 8, sizeId: 17, setIds: '26' });

    expect(response.status).toBe(200);
    expect(control.insertedValues).toHaveBeenCalledWith(
      expect.objectContaining({ layoutId: 0, sizeId: 0, setIds: '' }),
    );
  });

  it('stores a Kilter controller as it was sent', async () => {
    const response = await register({ boardName: 'kilter', layoutId: 8, sizeId: 17, setIds: '26,27' });

    expect(response.status).toBe(200);
    expect(control.insertedValues).toHaveBeenCalledWith(
      expect.objectContaining({ boardName: 'kilter', layoutId: 8, sizeId: 17, setIds: '26,27' }),
    );
  });

  it('still requires a configuration for Kilter and Tension', async () => {
    const response = await register({ boardName: 'tension' });

    expect(response.status).toBe(400);
    expect(control.insertedValues).not.toHaveBeenCalled();
  });

  it('refuses a board type that has no controller support', async () => {
    const response = await register({ boardName: 'moonboard', layoutId: 1, sizeId: 1, setIds: '1' });

    expect(response.status).toBe(400);
    expect(control.insertedValues).not.toHaveBeenCalled();
  });
});

describe('expected viewer on /api/internal/controllers', () => {
  const sends = {
    GET: () => GET(request('GET', undefined, 'user-2:login-2')),
    POST: () => POST(request('POST', { boardName: 'spray' }, 'user-2:login-2')),
    DELETE: () => DELETE(request('DELETE', { controllerId: CONTROLLER_ID }, 'user-2:login-2')),
  };

  it.each(Object.keys(sends) as (keyof typeof sends)[])(
    '%s from a tab that shows another account answers 409 and reads or writes nothing',
    async (method) => {
      const response = await sends[method]();

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: 'viewer_changed', error: 'Reload this page.' });
      expect(control.selected).not.toHaveBeenCalled();
      expect(control.insertedValues).not.toHaveBeenCalled();
      expect(control.deleted).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['GET', () => GET(request('GET', undefined, null))],
    ['POST', () => POST(request('POST', { boardName: 'spray' }, null))],
    ['DELETE', () => DELETE(request('DELETE', { controllerId: CONTROLLER_ID }, null))],
  ] as const)('%s without the header from a signed-in cookie is refused the same way', async (_method, send) => {
    const response = await send();

    expect(response.status).toBe(409);
    expect(control.selected).not.toHaveBeenCalled();
    expect(control.insertedValues).not.toHaveBeenCalled();
    expect(control.deleted).not.toHaveBeenCalled();
  });

  it('reads and deletes for the tab that names the cookie’s account', async () => {
    expect((await GET(request('GET'))).status).toBe(200);
    expect((await DELETE(request('DELETE', { controllerId: CONTROLLER_ID }))).status).toBe(200);

    expect(control.selected).toHaveBeenCalledOnce();
    expect(control.deleted).toHaveBeenCalledOnce();
  });

  it('still answers 401 to a signed-out request that names nobody', async () => {
    control.session.mockResolvedValue(null);

    const response = await GET(request('GET', undefined, null));

    expect(response.status).toBe(401);
    expect(control.selected).not.toHaveBeenCalled();
  });
});
