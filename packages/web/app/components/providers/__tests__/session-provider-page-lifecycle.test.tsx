import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useSession } from 'next-auth/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/lib/auth/nextauth-cookie-fetch-lock', () => ({ installNextAuthCookieFetchLock: () => {} }));
vi.mock('@/app/lib/user-preferences-db', () => ({ removePreference: async () => {} }));
import SessionProviderWrapper from '../session-provider';

function session(userId: string) {
  return {
    user: { id: userId },
    authSessionId: `${userId}-login`,
    expires: '2099-01-01T00:00:00.000Z',
  };
}

const observed = { session: null as unknown, status: 'loading' as string };
function Consumer() {
  const { data: current, status } = useSession();
  observed.session = current;
  observed.status = status;
  return <p>{status === 'authenticated' ? `Signed in as ${current?.user?.id}` : status}</p>;
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
  readSession = vi.fn<typeof fetch>(async () => Response.json(session('climber-a')));
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
    await screen.findByText('Signed in as climber-a');
    const acceptedBeforeHide = observed.session;
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    expect(observed.status).toBe('authenticated');
    expect(observed.session).toBe(acceptedBeforeHide);
  });

  it('re-reads the session when a suspended page is restored', async () => {
    renderConsumer();
    await screen.findByText('Signed in as climber-a');
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    readSession.mockImplementationOnce(async () => Response.json(session('climber-b')));
    await act(async () => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await screen.findByText('Signed in as climber-b');
    expect(readSession).toHaveBeenCalledTimes(2);
  });

  it('does not re-read on a first pageshow and removes its listeners on unmount', async () => {
    const { unmount } = renderConsumer();
    await screen.findByText('Signed in as climber-a');
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
