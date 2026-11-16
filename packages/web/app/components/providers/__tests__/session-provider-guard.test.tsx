import 'fake-indexeddb/auto';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Session } from 'next-auth';
import { useSession } from 'next-auth/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionProviderWrapper from '../session-provider';
import QueryClientProvider from '../query-client-provider';
import { WEB_SESSION_CHECK_EVENT } from '@/app/lib/auth/session-guard';

const reload = vi.hoisted(() => vi.fn<() => void>());
vi.mock('@/app/lib/auth/reload-to-locale-root', () => ({ reloadToLocaleRoot: reload }));

const GUARD_KEY = Symbol.for('boardsesh.web-session-guard.v1');
const LOCK_INSTALLATION_KEY = Symbol.for('boardsesh.nextauth-cookie-fetch-lock.state-v1');

function session(userId: string, authSessionId: string): Session {
  return { user: { id: userId }, authSessionId, expires: '2099-01-01T00:00:00.000Z' };
}

/** Every state any render published, so a test can prove B never appeared. */
const published: string[] = [];
let queryClient: QueryClient | undefined;
function Recorder() {
  const { data, status } = useSession();
  queryClient = useQueryClient();
  const state = `${status}:${data?.user.id ?? 'none'}:${data?.authSessionId ?? 'none'}`;
  published.push(state);
  return <output>{state}</output>;
}

let serverSession: Session | null;
let sessionStatus: number;
let probeStatus: number;
let fetchMock: ReturnType<typeof vi.fn>;
const calls = (path: string) =>
  fetchMock.mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input).endsWith(path)).length;

beforeEach(() => {
  for (const key of [GUARD_KEY, LOCK_INSTALLATION_KEY])
    delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[key];
  reload.mockReset();
  published.length = 0;
  queryClient = undefined;
  serverSession = null;
  sessionStatus = 200;
  probeStatus = 200;
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const endpoint = String(input instanceof Request ? input.url : input);
    if (endpoint.endsWith('/api/internal/ws-auth')) {
      const probe = serverSession
        ? {
            token: 'jwe',
            authenticated: true,
            userId: serverSession.user.id,
            authSessionId: serverSession.authSessionId,
          }
        : { token: null, authenticated: false };
      return Response.json(probe, { status: probeStatus });
    }
    return Response.json(serverSession ?? {}, { status: sessionStatus });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderProviders() {
  return render(
    <SessionProviderWrapper>
      <QueryClientProvider>
        <Recorder />
      </QueryClientProvider>
    </SessionProviderWrapper>,
  );
}

async function anotherTabWrites(next: Session | null) {
  serverSession = next;
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: 'nextauth.message' }));
  });
}

describe('account change seen from another tab or app', () => {
  it.each([
    ['another account', session('user-b', 'login-b')],
    ['signed out', null],
  ] as const)('never publishes %s in A’s page; it clears caches, then reloads', async (_label, next) => {
    serverSession = session('user-a', 'login-a');
    renderProviders();
    await screen.findByText('authenticated:user-a:login-a');
    act(() => {
      queryClient?.setQueryData(['profile', 'user-a'], { email: 'a@example.invalid' });
    });
    let cachedAtReload = -1;
    reload.mockImplementation(() => {
      cachedAtReload = queryClient?.getQueryCache().getAll().length ?? -1;
    });

    await anotherTabWrites(next);

    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(cachedAtReload).toBe(0);
    expect(screen.getByText('loading:none:none')).toBeTruthy();
    expect(published.filter((state) => !state.includes('user-a') && state !== 'loading:none:none')).toEqual([]);
  });

  it('publishes a sign-in from another tab without reloading', async () => {
    renderProviders();
    await screen.findByText('unauthenticated:none:none');

    await anotherTabWrites(session('user-a', 'login-a'));

    await screen.findByText('authenticated:user-a:login-a');
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps the page through an outage and never reads it as a sign-out', async () => {
    serverSession = session('user-a', 'login-a');
    renderProviders();
    await screen.findByText('authenticated:user-a:login-a');
    sessionStatus = 503;
    probeStatus = 503;

    await anotherTabWrites(null);
    act(() => {
      window.dispatchEvent(new Event(WEB_SESSION_CHECK_EVENT));
    });

    await waitFor(() => expect(calls('/api/internal/ws-auth')).toBe(1));
    await act(async () => {});
    expect(screen.getByText('authenticated:user-a:login-a')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('re-reading the session', () => {
  it('checks on focus through the cookie-free probe, at most once per 30 seconds', async () => {
    vi.useFakeTimers();
    serverSession = session('user-a', 'login-a');
    renderProviders();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('authenticated:user-a:login-a')).toBeTruthy();
    const focus = async () => {
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        await vi.advanceTimersByTimeAsync(0);
      });
    };

    await focus();
    expect(calls('/api/internal/ws-auth')).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await focus();
    await focus();
    expect(calls('/api/internal/ws-auth')).toBe(1);
    expect(calls('/api/auth/session')).toBe(1);

    // Same account, new login elsewhere: the probe differs, so the session is read once.
    serverSession = session('user-a', 'login-a2');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    await focus();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls('/api/internal/ws-auth')).toBe(2);
    expect(calls('/api/auth/session')).toBe(2);
    expect(screen.getByText('authenticated:user-a:login-a2')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it('a 401 re-check skips the focus throttle and retires a page whose login was revoked', async () => {
    serverSession = session('user-a', 'login-a');
    renderProviders();
    await screen.findByText('authenticated:user-a:login-a');
    serverSession = null;

    act(() => {
      window.dispatchEvent(new Event(WEB_SESSION_CHECK_EVENT));
    });

    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(calls('/api/internal/ws-auth')).toBe(1);
    expect(screen.getByText('loading:none:none')).toBeTruthy();
  });

  it('a matching probe never reads the session, so the cookie is not rewritten', async () => {
    serverSession = session('user-a', 'login-a');
    renderProviders();
    await screen.findByText('authenticated:user-a:login-a');

    act(() => {
      window.dispatchEvent(new Event(WEB_SESSION_CHECK_EVENT));
    });

    await waitFor(() => expect(calls('/api/internal/ws-auth')).toBe(1));
    await act(async () => {});
    expect(calls('/api/auth/session')).toBe(1);
  });
});
