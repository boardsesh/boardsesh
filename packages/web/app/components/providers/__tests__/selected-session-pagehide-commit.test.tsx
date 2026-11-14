import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useSession } from 'next-auth/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import { readBrowserBackendSessionScope } from '@boardsesh/auth-protocol/browser-backend-session';

const control = vi.hoisted(() => ({
  client: null as ReturnType<typeof createBrowserBackendClient> | null,
  refresh: vi.fn(),
  currentSession: null as unknown,
  currentStatus: 'loading' as 'loading' | 'authenticated' | 'unauthenticated',
  blockSubscriptions: false,
  blockedSubscriptions: 0,
}));

function blockSubscription() {
  control.blockedSubscriptions += 1;
  return () => {};
}
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: control.refresh }) }));
vi.mock('@/app/lib/auth/nextauth-cookie-fetch-lock', () => ({ installNextAuthCookieFetchLock: () => {} }));
vi.mock('@/app/lib/user-preferences-db', () => ({ removePreference: async () => {} }));
vi.mock('@/app/lib/auth/browser-backend-client', () => ({
  browserBackendClient: new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'subscribe' && control.blockSubscriptions) return blockSubscription;
        return Reflect.get(control.client!, property);
      },
    },
  ),
}));
import SessionProviderWrapper from '../session-provider';
import SelectedPrivateView from '@/app/components/auth/selected-private-view';

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
  const { data: current, status } = useSession();
  control.currentSession = current;
  control.currentStatus = status;
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
  control.currentSession = null;
  control.currentStatus = 'loading';
  control.blockSubscriptions = false;
  control.blockedSubscriptions = 0;
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

describe('pagehide commits private retirement before the next native listener', () => {
  it('retires the manager receipt and removes private DOM inside the same native event', async () => {
    renderConsumer();
    await screen.findByText('Private client:climber-a');
    const acceptedBeforeHide = control.currentSession;
    let observed: { owner: unknown; receiptCurrent: boolean; privateVisible: boolean } | undefined;
    const inspectAfterProvider = () => {
      observed = {
        owner: control.client!.getSnapshot().owner,
        receiptCurrent: control.client!.isSessionCurrent(acceptedBeforeHide),
        privateVisible: screen.queryByText('Private client:climber-a') !== null,
      };
    };
    window.addEventListener('pagehide', inspectAfterProvider);
    try {
      act(() => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      });
      expect(observed).toEqual({ owner: null, receiptCurrent: false, privateVisible: false });
    } finally {
      window.removeEventListener('pagehide', inspectAfterProvider);
    }
  });

  it('removes private DOM synchronously before a child subscription is registered', async () => {
    control.blockSubscriptions = true;
    renderConsumer();
    await screen.findByText('Private client:climber-a');
    await waitFor(() => expect(control.blockedSubscriptions).toBeGreaterThan(0));
    expect(control.client!.isSessionCurrent(control.currentSession)).toBe(true);
    const acceptedBeforeHide = control.currentSession;
    let observed: { owner: unknown; receiptCurrent: boolean; privateVisible: boolean } | undefined;
    const inspectAfterProvider = () => {
      observed = {
        owner: control.client!.getSnapshot().owner,
        receiptCurrent: control.client!.isSessionCurrent(acceptedBeforeHide),
        privateVisible: screen.queryByText('Private client:climber-a') !== null,
      };
    };
    window.addEventListener('pagehide', inspectAfterProvider);
    try {
      act(() => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      });
      expect(observed).toEqual({ owner: null, receiptCurrent: false, privateVisible: false });
    } finally {
      window.removeEventListener('pagehide', inspectAfterProvider);
    }
  });

  it.each([
    ['an authority outage', () => Response.json({ error: 'unavailable' }, { status: 503 })],
    ['a malformed response', () => Response.json({ user: {} })],
  ])('keeps retirement unknown during %s and restores only an admitted read', async (_description, refusedResponse) => {
    control.blockSubscriptions = true;
    renderConsumer();
    await screen.findByText('Private client:climber-a');
    const acceptedBeforeHide = control.currentSession;
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    expect(screen.queryByText('Private client:climber-a')).toBeNull();
    expect(control.currentStatus).toBe('loading');
    expect(control.client!.isAnonymous()).toBe(false);

    readSession.mockResolvedValueOnce(refusedResponse());
    await act(async () => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    expect(readSession).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Private client:climber-a')).toBeNull();
    expect(control.currentStatus).toBe('loading');
    expect(control.client!.isSessionCurrent(acceptedBeforeHide)).toBe(false);
    expect(control.client!.isAnonymous()).toBe(false);

    const { requestWebSessionRefresh } = await import('@/app/lib/auth/web-session-events');
    await act(async () => requestWebSessionRefresh());
    await screen.findByText('Private client:climber-a');
    expect(control.currentStatus).toBe('authenticated');
    expect(control.client!.isSessionCurrent(control.currentSession)).toBe(true);
    expect(control.client!.isSessionCurrent(acceptedBeforeHide)).toBe(false);
  });

  it('cannot publish an abort-ignoring old same-owner body after a refused restoration', async () => {
    control.blockSubscriptions = true;
    renderConsumer();
    await screen.findByText('Private client:climber-a');
    const acceptedBeforeHide = control.currentSession;
    const { requestWebSessionRefresh } = await import('@/app/lib/auth/web-session-events');
    let releaseOldBody!: (body: unknown) => void;
    readSession.mockResolvedValueOnce({
      ok: true,
      json: () => new Promise((resolve) => (releaseOldBody = resolve)),
    } as Response);
    act(() => requestWebSessionRefresh());
    await waitFor(() => expect(releaseOldBody).toBeTypeOf('function'));
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    expect(screen.queryByText('Private client:climber-a')).toBeNull();

    readSession.mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }));
    await act(async () => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await act(async () => releaseOldBody(session()));
    expect(control.currentStatus).toBe('loading');
    expect(screen.queryByText('Private client:climber-a')).toBeNull();
    expect(control.client!.isSessionCurrent(acceptedBeforeHide)).toBe(false);
    expect(control.client!.isAnonymous()).toBe(false);
  });

  it('accepts anonymous only after a fresh successful central response', async () => {
    control.blockSubscriptions = true;
    renderConsumer();
    await screen.findByText('Private client:climber-a');
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    expect(control.currentStatus).toBe('loading');
    expect(control.client!.isAnonymous()).toBe(false);
    readSession.mockResolvedValueOnce(Response.json({}));
    await act(async () => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    expect(control.currentStatus).toBe('unauthenticated');
    expect(control.client!.isAnonymous()).toBe(true);
    expect(screen.queryByText('Private client:climber-a')).toBeNull();
  });

  it('retains the existing legacy context when selected admission is inactive', async () => {
    control.client?.dispose();
    control.client = createBrowserBackendClient({
      ready: () => false,
      fetch: vi.fn<typeof fetch>(),
      endpoint: '/owned-lease',
      now: () => 0,
      schedule: () => () => {},
    });
    const { browserSelection: _selection, ...legacySession } = session();
    readSession.mockImplementation(async () => Response.json(legacySession));
    renderConsumer();
    await waitFor(() => expect(control.currentStatus).toBe('authenticated'));
    const acceptedBeforeHide = control.currentSession;
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    expect(control.client.isSelected()).toBe(false);
    expect(control.currentStatus).toBe('authenticated');
    expect(control.currentSession).toBe(acceptedBeforeHide);
  });
});
