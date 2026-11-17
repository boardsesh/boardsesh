// @vitest-environment node
/**
 * The race #7596 decision 4 closes, from the www guard to the route handler.
 * Tab A shows user-a. The shared `.boardsesh.com` cookie switches to user-b on
 * the other origin, and tab A has not noticed yet. Its next request must not
 * read or write user-b's controllers. The cookie is the mocked admitted
 * session; the guard and the route are the real ones. A real two-origin
 * browser run is not covered (no account-switching Playwright harness exists).
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createSessionGuard, isSessionSuperseded } from '@/app/lib/auth/session-guard';

const cookie = vi.hoisted(() => ({ session: vi.fn(), selectedFor: vi.fn(), deleted: vi.fn(), inserted: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/auth/admitted-session.server', () => ({ getAdmittedServerSession: cookie.session }));
vi.mock('@/app/lib/db/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: async () => {
          cookie.selectedFor((await cookie.session())?.user.id);
          return [];
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        cookie.deleted((await cookie.session())?.user.id);
      },
    }),
    insert: () => ({
      values: (values: { userId: string }) => {
        cookie.inserted(values.userId);
        return { returning: async () => [{ id: 'controller-1', createdAt: new Date(), ...values }] };
      },
    }),
  }),
}));

import { DELETE, GET, POST } from '../route';

const PAGE_ORIGIN = 'https://www.boardsesh.test';
const signedInAs = (userId: string, authSessionId: string) => ({ user: { id: userId }, authSessionId });

/** Same-origin fetch answered by the route handlers, carrying the shared cookie. */
const sendToRoute: typeof fetch = async (input, init) => {
  const target = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
  const request = new NextRequest(new URL(target, PAGE_ORIGIN), init as ConstructorParameters<typeof NextRequest>[1]);
  if (request.method === 'POST') return POST(request);
  return request.method === 'DELETE' ? DELETE(request) : GET(request);
};

let requestSessionCheck: ReturnType<typeof vi.fn<() => void>>;

function tabShowing(viewer: { userId: string; authSessionId: string }) {
  const guard = createSessionGuard({
    reloadPage: vi.fn(),
    requestSessionCheck,
    pageOrigin: () => PAGE_ORIGIN,
    send: sendToRoute,
  });
  guard.accept(viewer);
  return guard;
}

beforeEach(() => {
  vi.clearAllMocks();
  requestSessionCheck = vi.fn<() => void>();
  cookie.session.mockResolvedValue(signedInAs('user-a', 'login-a'));
});

describe('a tab that has not noticed an account switch on the other origin', () => {
  it('reads its own controllers while the cookie still names it', async () => {
    const tab = tabShowing({ userId: 'user-a', authSessionId: 'login-a' });

    const response = await tab.fetch('/api/internal/controllers');

    expect(response.status).toBe(200);
    expect(cookie.selectedFor).toHaveBeenCalledWith('user-a');
  });

  it('never reads the new account’s controllers; the caller gets superseded and the session is re-checked', async () => {
    const tab = tabShowing({ userId: 'user-a', authSessionId: 'login-a' });
    cookie.session.mockResolvedValue(signedInAs('user-b', 'login-b'));

    await expect(tab.fetch('/api/internal/controllers')).rejects.toSatisfy(isSessionSuperseded);

    expect(cookie.selectedFor).not.toHaveBeenCalled();
    expect(requestSessionCheck).toHaveBeenCalledOnce();
  });

  it('never deletes under the new account', async () => {
    const tab = tabShowing({ userId: 'user-a', authSessionId: 'login-a' });
    cookie.session.mockResolvedValue(signedInAs('user-b', 'login-b'));

    await expect(
      tab.fetch('/api/internal/controllers', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ controllerId: '3f0c6a8e-2f4b-4c1e-9d7a-5b6c7d8e9f01' }),
      }),
    ).rejects.toSatisfy(isSessionSuperseded);

    expect(cookie.deleted).not.toHaveBeenCalled();
    expect(requestSessionCheck).toHaveBeenCalledOnce();
  });

  it('never registers a controller, and its one-time key, under the new account', async () => {
    const tab = tabShowing({ userId: 'user-a', authSessionId: 'login-a' });
    cookie.session.mockResolvedValue(signedInAs('user-b', 'login-b'));

    await expect(
      tab.fetch('/api/internal/controllers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Projector', boardName: 'spray' }),
      }),
    ).rejects.toSatisfy(isSessionSuperseded);

    expect(cookie.inserted).not.toHaveBeenCalled();
    expect(requestSessionCheck).toHaveBeenCalledOnce();
  });

  it('registers for its own account while the cookie still names it', async () => {
    const tab = tabShowing({ userId: 'user-a', authSessionId: 'login-a' });

    const response = await tab.fetch('/api/internal/controllers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boardName: 'spray' }),
    });

    expect(response.status).toBe(200);
    expect(cookie.inserted).toHaveBeenCalledWith('user-a');
  });

  it('a signed-out tab is refused a signed-in cookie’s data too', async () => {
    const tab = createSessionGuard({
      reloadPage: vi.fn(),
      requestSessionCheck,
      pageOrigin: () => PAGE_ORIGIN,
      send: sendToRoute,
    });
    tab.accept(null);

    await expect(tab.fetch('/api/internal/controllers')).rejects.toSatisfy(isSessionSuperseded);

    expect(cookie.selectedFor).not.toHaveBeenCalled();
  });
});
