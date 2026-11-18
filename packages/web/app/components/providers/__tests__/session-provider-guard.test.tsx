import 'fake-indexeddb/auto';
import type { ReactNode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  dehydrate,
  QueryClient as DehydratingClient,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { openDB } from 'idb';
import type { Session } from 'next-auth';
import { useSession } from 'next-auth/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionProviderWrapper from '../session-provider';
import QueryClientProvider from '../query-client-provider';
import {
  guardedActionFetch,
  guardedFetch,
  isSessionSuperseded,
  WEB_SESSION_CHECK_EVENT,
} from '@/app/lib/auth/session-guard';
import { guardedNextAuthSignOut } from '@/app/lib/auth/nextauth-cookie-fetch-lock';
import { signInWithSessionIntent } from '@/app/lib/auth/web-session-events';

const reload = vi.hoisted(() => vi.fn<() => void>());
vi.mock('@/app/lib/auth/reload-after-account-change', () => ({ reloadAfterAccountChange: reload }));

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
/** Set by a test to answer NextAuth's sign-in and sign-out endpoints. */
let authRoute: ((endpoint: string) => Response | undefined) | undefined;
/** Set by a test to hold the session read open. */
let sessionRead: Promise<void> | undefined;
/** Set by a test to hold the identity probe open after it read the cookie. */
let probeRead: Promise<void> | undefined;
/** The expected-viewer header each `/api/internal/controllers` request carried. */
const namedViewers: (string | null)[] = [];
let fetchMock: ReturnType<typeof vi.fn>;
const calls = (path: string) =>
  fetchMock.mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input).endsWith(path)).length;

beforeEach(async () => {
  for (const key of [GUARD_KEY, LOCK_INSTALLATION_KEY])
    delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[key];
  reload.mockReset();
  published.length = 0;
  queryClient = undefined;
  serverSession = null;
  sessionStatus = 200;
  probeStatus = 200;
  authRoute = undefined;
  sessionRead = undefined;
  probeRead = undefined;
  namedViewers.length = 0;
  const persistedCache = await openDB('boardsesh-react-query', 1, {
    upgrade(upgradeDb) {
      if (!upgradeDb.objectStoreNames.contains('cache')) upgradeDb.createObjectStore('cache');
    },
  });
  await persistedCache.clear('cache');
  persistedCache.close();
  vi.stubGlobal('BroadcastChannel', undefined);
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(input instanceof Request ? input.url : input);
    const authReply = authRoute?.(endpoint);
    if (authReply) return authReply;
    if (endpoint.endsWith('/api/internal/ws-auth')) {
      const probe = serverSession
        ? {
            token: 'jwe',
            authenticated: true,
            userId: serverSession.user.id,
            authSessionId: serverSession.authSessionId,
          }
        : { token: null, authenticated: false };
      await probeRead;
      return Response.json(probe, { status: probeStatus });
    }
    if (endpoint.endsWith('/api/internal/controllers')) {
      // The route's expected-viewer check, against the shared cookie.
      const named = new Headers(init?.headers).get('X-Boardsesh-Expected-Viewer');
      namedViewers.push(named);
      const cookieViewer = serverSession ? `${serverSession.user.id}:${serverSession.authSessionId}` : 'anonymous';
      return named === cookieViewer
        ? Response.json({ controllers: [] })
        : Response.json({ code: 'viewer_changed' }, { status: 409 });
    }
    await sessionRead;
    return Response.json(serverSession ?? {}, { status: sessionStatus });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderProviders(extra?: ReactNode) {
  return render(
    <SessionProviderWrapper>
      <QueryClientProvider>
        <Recorder />
        {extra}
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
  it('checks on the first focus, then at most once per 30 seconds, through the cookie-free probe', async () => {
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
    await focus();
    expect(calls('/api/internal/ws-auth')).toBe(1);
    expect(calls('/api/auth/session')).toBe(1);

    // Same account, new login elsewhere: the probe differs, so the session is read once.
    serverSession = session('user-a', 'login-a2');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000);
    });
    await focus();
    expect(calls('/api/internal/ws-auth')).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
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

  it('a probe answered 401 (a session that ended, under better-auth) reads the session, which retires the page', async () => {
    serverSession = session('user-a', 'login-a');
    renderProviders();
    await screen.findByText('authenticated:user-a:login-a');
    serverSession = null;
    probeStatus = 401;

    act(() => {
      window.dispatchEvent(new Event(WEB_SESSION_CHECK_EVENT));
    });

    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(calls('/api/auth/session')).toBe(2);
  });

  it('a probe 401 the session read does not confirm is read once, then proves nothing', async () => {
    serverSession = session('user-a', 'login-a');
    renderProviders();
    await screen.findByText('authenticated:user-a:login-a');
    probeStatus = 401;

    act(() => {
      window.dispatchEvent(new Event(WEB_SESSION_CHECK_EVENT));
    });
    await waitFor(() => expect(calls('/api/auth/session')).toBe(2));
    act(() => {
      window.dispatchEvent(new Event(WEB_SESSION_CHECK_EVENT));
    });
    await waitFor(() => expect(calls('/api/internal/ws-auth')).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls('/api/auth/session')).toBe(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it('a probe answered 503 proves nothing: no session read, the page keeps its account', async () => {
    serverSession = session('user-a', 'login-a');
    renderProviders();
    await screen.findByText('authenticated:user-a:login-a');
    probeStatus = 503;

    act(() => {
      window.dispatchEvent(new Event(WEB_SESSION_CHECK_EVENT));
    });

    await waitFor(() => expect(calls('/api/internal/ws-auth')).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls('/api/auth/session')).toBe(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('a request answered viewer_changed re-checks at once and retires a page whose cookie moved to B', async () => {
    serverSession = session('user-a', 'login-a');
    renderProviders();
    await screen.findByText('authenticated:user-a:login-a');
    // B signs in on the other origin. No storage event or broadcast reaches this tab.
    serverSession = session('user-b', 'login-b');

    let rejection: unknown;
    await act(async () => {
      rejection = await guardedFetch('/api/internal/controllers').catch((error: unknown) => error);
    });

    expect(isSessionSuperseded(rejection)).toBe(true);
    expect(namedViewers).toEqual(['user-a:login-a']);
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(calls('/api/internal/ws-auth')).toBe(1);
    expect(published.some((state) => state.includes('user-b'))).toBe(false);
  });

  it('a delete refused after a new login of the same account goes through once the re-check accepts it', async () => {
    serverSession = session('user-a', 'login-a');
    renderProviders();
    await screen.findByText('authenticated:user-a:login-a');
    serverSession = session('user-a', 'login-a2');

    let response: Response | undefined;
    await act(async () => {
      response = await guardedActionFetch('/api/internal/controllers', { method: 'DELETE' });
    });

    expect(response?.status).toBe(200);
    expect(namedViewers).toEqual(['user-a:login-a', 'user-a:login-a2']);
    expect(calls('/api/internal/ws-auth')).toBe(1);
    expect(screen.getByText('authenticated:user-a:login-a2')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it('a viewer_changed answer during a focus probe runs one more probe after it', async () => {
    serverSession = session('user-a', 'login-a');
    renderProviders();
    await screen.findByText('authenticated:user-a:login-a');
    let releaseProbe = () => {};
    probeRead = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    // This probe reads the cookie while it still names A, then is held.
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(calls('/api/internal/ws-auth')).toBe(1));
    serverSession = session('user-b', 'login-b');

    await act(async () => {
      await guardedFetch('/api/internal/controllers').catch(() => {});
    });
    expect(calls('/api/internal/ws-auth')).toBe(1);
    act(() => releaseProbe());

    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(calls('/api/internal/ws-auth')).toBe(2);
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

const origin = () => window.location.origin;

/** NextAuth's sign-out endpoints. The POST clears the cookie. */
function signOutRoutes(endpoint: string): Response | undefined {
  if (endpoint.endsWith('/api/auth/csrf')) return Response.json({ csrfToken: 'fixture-csrf' });
  if (endpoint.endsWith('/api/auth/signout')) {
    serverSession = null;
    return Response.json({ url: `${origin()}/` });
  }
  return undefined;
}

/** NextAuth's credentials sign-in endpoints. A good password signs in `next`. */
function signInRoutes(next: Session, accepted: boolean) {
  return (endpoint: string): Response | undefined => {
    if (endpoint.endsWith('/api/auth/providers'))
      return Response.json({
        credentials: { id: 'credentials', type: 'credentials', name: 'Credentials', signinUrl: '', callbackUrl: '' },
      });
    if (endpoint.endsWith('/api/auth/csrf')) return Response.json({ csrfToken: 'fixture-csrf' });
    if (!endpoint.endsWith('/api/auth/callback/credentials')) return undefined;
    if (!accepted) return Response.json({ url: `${origin()}/api/auth/error?error=CredentialsSignin` }, { status: 401 });
    serverSession = next;
    return Response.json({ url: `${origin()}/` });
  };
}

const signIn = () =>
  signInWithSessionIntent('credentials', {
    redirect: false,
    email: 'fixture@example.invalid',
    password: 'fixture-only',
  });

describe('this tab’s own sign-in and sign-out', () => {
  it('publishes its own sign-out without a reload', async () => {
    serverSession = session('user-a', 'login-a');
    renderProviders();
    await screen.findByText('authenticated:user-a:login-a');
    authRoute = signOutRoutes;

    await act(async () => {
      await guardedNextAuthSignOut(
        { userId: 'user-a', authSessionId: 'login-a' },
        { callbackUrl: `${origin()}/`, redirect: false },
      );
    });

    await screen.findByText('unauthenticated:none:none');
    expect(reload).not.toHaveBeenCalled();
  });

  it('retires the page when its sign-out finds the cookie already names another account', async () => {
    serverSession = session('user-a', 'login-a');
    renderProviders();
    await screen.findByText('authenticated:user-a:login-a');
    serverSession = session('user-b', 'login-b');
    authRoute = signOutRoutes;

    let outcome: Awaited<ReturnType<typeof guardedNextAuthSignOut>> | undefined;
    await act(async () => {
      outcome = await guardedNextAuthSignOut(
        { userId: 'user-a', authSessionId: 'login-a' },
        { callbackUrl: `${origin()}/`, redirect: false },
      );
    });

    expect(outcome?.status).toBe('identity-changed');
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(published.some((state) => state.includes('user-b'))).toBe(false);
  });

  it('claims nothing when its sign-out fails before sending, so a switch elsewhere still retires', async () => {
    serverSession = session('user-a', 'login-a');
    renderProviders();
    await screen.findByText('authenticated:user-a:login-a');
    sessionStatus = 500;

    await act(async () => {
      await expect(
        guardedNextAuthSignOut({ userId: 'user-a', authSessionId: 'login-a' }, { redirect: false }),
      ).rejects.toThrow('Unable to verify the session before signing out');
    });
    sessionStatus = 200;
    await anotherTabWrites(session('user-b', 'login-b'));

    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(published.some((state) => state.includes('user-b'))).toBe(false);
  });

  it.each([
    ['signed out', null],
    ['signed in as A', session('user-a', 'login-a')],
  ] as const)('publishes its own sign-in from %s without a reload', async (_label, start) => {
    serverSession = start;
    renderProviders();
    await screen.findByText(start ? 'authenticated:user-a:login-a' : 'unauthenticated:none:none');
    authRoute = signInRoutes(session('user-b', 'login-b'), true);

    await act(async () => {
      await signIn();
    });

    await screen.findByText('authenticated:user-b:login-b');
    expect(reload).not.toHaveBeenCalled();
  });

  it('a failed sign-in claims nothing, so a switch elsewhere still retires', async () => {
    serverSession = session('user-a', 'login-a');
    renderProviders();
    await screen.findByText('authenticated:user-a:login-a');
    authRoute = signInRoutes(session('user-b', 'login-b'), false);

    let outcome: Awaited<ReturnType<typeof signIn>>;
    await act(async () => {
      outcome = await signIn();
    });
    expect(outcome?.error).toBe('CredentialsSignin');
    await act(async () => {});
    await anotherTabWrites(session('user-b', 'login-b'));

    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(published.some((state) => state.includes('user-b'))).toBe(false);
  });
});

describe('persisted cache restore', () => {
  it('starts queries before the first session read, then hydrates the owner’s cache', async () => {
    const writer = new DehydratingClient();
    writer.setQueryData(['profile', 'user-a'], { email: 'a@example.invalid' });
    const persistedCache = await openDB('boardsesh-react-query', 1);
    await persistedCache.put(
      'cache',
      { owner: 'user-a:login-a', client: { timestamp: Date.now(), buster: '', clientState: dehydrate(writer) } },
      'client',
    );
    persistedCache.close();
    let releaseSession!: () => void;
    sessionRead = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    serverSession = session('user-a', 'login-a');
    const publicQuery = vi.fn(async () => ['gym']);
    function PublicGyms() {
      useQuery({ queryKey: ['public-gyms'], queryFn: publicQuery });
      return null;
    }

    renderProviders(<PublicGyms />);

    await waitFor(() => expect(publicQuery).toHaveBeenCalledOnce());
    expect(screen.getByText('loading:none:none')).toBeTruthy();
    expect(queryClient?.getQueryData(['profile', 'user-a'])).toBeUndefined();

    act(() => releaseSession());

    await screen.findByText('authenticated:user-a:login-a');
    await waitFor(() =>
      expect(queryClient?.getQueryData(['profile', 'user-a'])).toEqual({ email: 'a@example.invalid' }),
    );
  });
});
