import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useSession } from 'next-auth/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/lib/auth/nextauth-cookie-fetch-lock', () => ({ installNextAuthCookieFetchLock: () => {} }));
// The session guard retires the page on a switch to another account; these
// tests restore a new login of the same climber, which the guard publishes.
const reload = vi.hoisted(() => vi.fn<() => void>());
vi.mock('@/app/lib/auth/reload-after-account-change', () => ({ reloadAfterAccountChange: reload }));
import SessionProviderWrapper from '../session-provider';
import { requestWebSessionRefresh } from '@/app/lib/auth/web-session-events';

const GUARD_KEY = Symbol.for('boardsesh.web-session-guard.v1');

function session(authSessionId: string) {
  return {
    user: { id: 'climber-a' },
    authSessionId,
    expires: '2099-01-01T00:00:00.000Z',
  };
}

const observed = { session: null as unknown, status: 'loading' as string };
function Consumer() {
  const { data: current, status } = useSession();
  observed.session = current;
  observed.status = status;
  return <p>{status === 'authenticated' ? `Signed in on ${current?.authSessionId}` : status}</p>;
}
function renderConsumer() {
  return render(
    <SessionProviderWrapper>
      <Consumer />
    </SessionProviderWrapper>,
  );
}

let readSession: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[GUARD_KEY];
  reload.mockReset();
  readSession = vi.fn<typeof fetch>(async () => Response.json(session('login-1')));
  vi.stubGlobal('fetch', readSession);
  observed.session = null;
  observed.status = 'loading';
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('session provider across page suspension', () => {
  it('keeps the accepted session through pagehide', async () => {
    renderConsumer();
    await screen.findByText('Signed in on login-1');
    const acceptedBeforeHide = observed.session;
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    expect(observed.status).toBe('authenticated');
    expect(observed.session).toBe(acceptedBeforeHide);
  });

  it('re-reads the session when a suspended page is restored', async () => {
    renderConsumer();
    await screen.findByText('Signed in on login-1');
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    readSession.mockImplementationOnce(async () => Response.json(session('login-2')));
    await act(async () => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await screen.findByText('Signed in on login-2');
    expect(readSession).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not read the session while the page is suspended', async () => {
    renderConsumer();
    await screen.findByText('Signed in on login-1');
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    act(() => {
      requestWebSessionRefresh();
      window.dispatchEvent(new Event('online'));
    });
    expect(readSession).toHaveBeenCalledOnce();
    expect(screen.getByText('Signed in on login-1')).toBeTruthy();
  });

  it('drops a session body started before pagehide that lands after the restored read', async () => {
    renderConsumer();
    await screen.findByText('Signed in on login-1');
    let releaseOldBody: ((body: unknown) => void) | undefined;
    // No body stream: the provider awaits json(), which ignores the abort.
    readSession.mockResolvedValueOnce({
      ok: true,
      json: () => new Promise((resolve) => (releaseOldBody = resolve)),
    } as Response);
    act(() => requestWebSessionRefresh());
    await waitFor(() => expect(releaseOldBody).toBeTypeOf('function'));
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    readSession.mockImplementationOnce(async () => Response.json(session('login-2')));
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await screen.findByText('Signed in on login-2');
    await act(async () => releaseOldBody?.(session('login-1')));
    expect(screen.getByText('Signed in on login-2')).toBeTruthy();
    expect(screen.queryByText('Signed in on login-1')).toBeNull();
  });

  it('keeps the accepted session when the restored read hits an outage', async () => {
    renderConsumer();
    await screen.findByText('Signed in on login-1');
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    readSession.mockImplementationOnce(async () => Response.json({ error: 'unavailable' }, { status: 503 }));
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await waitFor(() => expect(readSession).toHaveBeenCalledTimes(2));
    await act(async () => Promise.resolve());
    expect(observed.status).toBe('authenticated');
    expect(screen.getByText('Signed in on login-1')).toBeTruthy();
  });

  it('does not re-read on a first pageshow and removes its listeners on unmount', async () => {
    const { unmount } = renderConsumer();
    await screen.findByText('Signed in on login-1');
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    });
    expect(readSession).toHaveBeenCalledOnce();
    unmount();
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await waitFor(() => expect(readSession).toHaveBeenCalledOnce());
  });
});
