import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useSession } from 'next-auth/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import { readBrowserBackendSessionScope } from '@boardsesh/auth-protocol/browser-backend-session';

const control = vi.hoisted(() => ({
  client: null as ReturnType<typeof createBrowserBackendClient> | null,
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: control.refresh }) }));
vi.mock('@/app/lib/auth/nextauth-cookie-fetch-lock', () => ({ installNextAuthCookieFetchLock: () => {} }));
vi.mock('@/app/lib/user-preferences-db', () => ({ removePreference: async () => {} }));
vi.mock('@/app/lib/auth/browser-backend-client', () => ({
  browserBackendClient: new Proxy(
    {},
    {
      get(_target, property) {
        return Reflect.get(control.client!, property);
      },
    },
  ),
}));
import SessionProviderWrapper from '../session-provider';
import SelectedPrivateView from '@/app/components/auth/selected-private-view';
import { requestWebSessionRefresh } from '@/app/lib/auth/web-session-events';

function session(userId = 'climber-a') {
  return {
    user: { id: userId },
    authSessionId: `${userId}-login`,
    authGeneration: 2,
    expires: '2099-01-01T00:00:00.000Z',
    browserSelection: {
      userId,
      authSessionId: `${userId}-login`,
      generation: 2,
      cursor: { bindingId: 'a'.repeat(64), version: 1 },
    },
  };
}
function Consumer() {
  const { data: current } = useSession();
  const observation = readBrowserBackendSessionScope(current);
  if (observation.status !== 'selected') return null;
  return (
    <SelectedPrivateView expectedOwner={observation.owner}>
      <p>{`Private client:${current?.user.id}`}</p>
    </SelectedPrivateView>
  );
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
  readSession = vi.fn<typeof fetch>(async () => Response.json(session()));
  vi.stubGlobal('fetch', readSession);
  control.refresh.mockReset();
  control.client = createBrowserBackendClient({
    ready: () => true,
    fetch: vi.fn<typeof fetch>(),
    endpoint: '/owned-lease',
    now: () => 0,
    schedule: () => () => {},
  });
});
afterEach(() => {
  cleanup();
  control.client?.dispose();
  control.client = null;
  vi.unstubAllGlobals();
});

describe('selected document suspension and restoration', () => {
  it('retires before page suspension and waits for fresh primary acceptance on restoration', async () => {
    renderConsumer();
    await screen.findByText('Private client:climber-a');
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    expect(screen.queryByText('Private client:climber-a')).toBeNull();
    expect(control.client!.isAnonymous()).toBe(false);
    const before = readSession.mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event('online'));
      requestWebSessionRefresh();
    });
    expect(readSession).toHaveBeenCalledTimes(before);
    let release!: (response: Response) => void;
    readSession.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    expect(screen.queryByText('Private client:climber-a')).toBeNull();
    await act(async () => release(Response.json(session('climber-b'))));
    await screen.findByText('Private client:climber-b');
    expect(screen.queryByText('Private client:climber-a')).toBeNull();
  });

  it('rejects an abort-ignoring pre-suspension body after the restored document accepts B', async () => {
    renderConsumer();
    await screen.findByText('Private client:climber-a');
    let release!: (body: unknown) => void;
    readSession.mockResolvedValueOnce({
      ok: true,
      json: () => new Promise((resolve) => (release = resolve)),
    } as Response);
    act(() => requestWebSessionRefresh());
    await waitFor(() => expect(release).toBeTypeOf('function'));
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    readSession.mockResolvedValueOnce(Response.json(session('climber-b')));
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await screen.findByText('Private client:climber-b');
    await act(async () => release(session()));
    expect(screen.queryByText('Private client:climber-a')).toBeNull();
    expect(screen.getByText('Private client:climber-b')).toBeTruthy();
  });

  it('keeps the restored private view hidden during an authority outage', async () => {
    renderConsumer();
    await screen.findByText('Private client:climber-a');
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    readSession.mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }));
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await waitFor(() => expect(readSession).toHaveBeenCalledTimes(2));
    await act(async () => Promise.resolve());
    expect(screen.queryByText('Private client:climber-a')).toBeNull();
    expect(control.client!.getSnapshot().owner).toBeNull();
    expect(control.client!.isAnonymous()).toBe(false);
  });

  it('does not re-read on initial pageshow and removes lifecycle listeners on unmount', async () => {
    const { unmount } = renderConsumer();
    await screen.findByText('Private client:climber-a');
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    });
    expect(readSession).toHaveBeenCalledOnce();
    unmount();
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    expect(readSession).toHaveBeenCalledOnce();
  });
});
