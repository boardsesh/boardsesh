import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { viewerMarkerValue } from '@boardsesh/auth-protocol/browser-session-cookie';
import SessionProviderWrapper, { useBrowserSession, type BrowserSession as Session } from '../session-provider';
import { guardedFetch, isSessionSuperseded } from '@/app/lib/auth/session-guard';

/**
 * The provider's half of the viewer marker (#7596 decision): a reply that
 * lands under another login's marker asks for the session check, and the
 * provider tells the guard whether the check named another account (retire),
 * confirmed the same login (deliver), or proved nothing (supersede).
 */

const reload = vi.hoisted(() => vi.fn<() => void>());
vi.mock('@/app/lib/auth/reload-after-account-change', () => ({ reloadAfterAccountChange: reload }));

const GUARD_KEY = Symbol.for('boardsesh.web-session-guard.v1');
const LOCK_INSTALLATION_KEY = Symbol.for('boardsesh.nextauth-cookie-fetch-lock.state-v1');
// jsdom serves the page over http, so the guard reads the plain marker name.
const MARKER_NAME = 'boardsesh.viewer';

function session(userId: string, authSessionId: string): Session {
  return { user: { id: userId }, authSessionId, expires: '2099-01-01T00:00:00.000Z' };
}

function Recorder() {
  const { data, status } = useBrowserSession();
  return <output>{`${status}:${data?.user.id ?? 'none'}:${data?.authSessionId ?? 'none'}`}</output>;
}

let serverSession: Session | null;
let probeStatus: number;
let fetchMock: ReturnType<typeof vi.fn>;
const calls = (path: string) =>
  fetchMock.mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input).endsWith(path)).length;

function setBrowserMarker(authSessionId: string | undefined) {
  document.cookie =
    authSessionId === undefined
      ? `${MARKER_NAME}=; Max-Age=0; Path=/`
      : `${MARKER_NAME}=${viewerMarkerValue(authSessionId)}; Path=/`;
}

beforeEach(() => {
  for (const key of [GUARD_KEY, LOCK_INSTALLATION_KEY])
    delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[key];
  reload.mockReset();
  serverSession = null;
  probeStatus = 200;
  vi.stubGlobal('BroadcastChannel', undefined);
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const endpoint = String(input instanceof Request ? input.url : input);
    if (endpoint.endsWith('/api/internal/ws-auth'))
      return Response.json(
        serverSession
          ? { authenticated: true, userId: serverSession.user.id, authSessionId: serverSession.authSessionId }
          : { authenticated: false },
        { status: probeStatus },
      );
    if (endpoint.endsWith('/api/internal/profile')) return Response.json({ saved: true });
    return Response.json(serverSession ?? {});
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  setBrowserMarker(undefined);
  vi.unstubAllGlobals();
});

/** Signed in as A with A's marker, once the guard has A's expected marker. */
async function signedInAsA() {
  serverSession = session('user-a', 'login-a');
  setBrowserMarker('login-a');
  render(
    <SessionProviderWrapper>
      <Recorder />
    </SessionProviderWrapper>,
  );
  await screen.findByText('authenticated:user-a:login-a');
  // The digest is WebCrypto's: let it land, then prove the match path checks nothing.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  await act(async () => {
    await guardedFetch('/api/internal/profile');
  });
  expect(calls('/api/internal/ws-auth')).toBe(0);
}

async function replyOutcome(): Promise<'delivered' | 'superseded'> {
  let outcome: 'delivered' | 'superseded' = 'delivered';
  await act(async () => {
    await guardedFetch('/api/internal/profile').catch((error: unknown) => {
      if (!isSessionSuperseded(error)) throw error;
      outcome = 'superseded';
    });
  });
  return outcome;
}

describe('a reply landing under another login’s viewer marker', () => {
  it('is superseded when the check names B, and the page retires without a focus', async () => {
    await signedInAsA();
    // B signs in on another host: the cookies change, no event reaches this tab.
    serverSession = session('user-b', 'login-b');
    setBrowserMarker('login-b');

    expect(await replyOutcome()).toBe('superseded');
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(calls('/api/internal/ws-auth')).toBe(1);
  });

  it('is delivered when the probe confirms the same login, and that value is never checked again', async () => {
    await signedInAsA();
    setBrowserMarker('a-value-from-a-sibling-host');

    expect(await replyOutcome()).toBe('delivered');
    expect(await replyOutcome()).toBe('delivered');
    expect(calls('/api/internal/ws-auth')).toBe(1);
    expect(reload).not.toHaveBeenCalled();
  });

  it('is superseded when the check proves nothing, and the page keeps its account', async () => {
    await signedInAsA();
    setBrowserMarker('another-false-value');
    probeStatus = 503;

    expect(await replyOutcome()).toBe('superseded');
    expect(calls('/api/internal/ws-auth')).toBe(1);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText('authenticated:user-a:login-a')).toBeTruthy();
  });
});
