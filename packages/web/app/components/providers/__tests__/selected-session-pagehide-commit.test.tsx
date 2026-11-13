import { act, cleanup, render, screen } from '@testing-library/react';
import { useSession } from 'next-auth/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import { readBrowserBackendSessionScope } from '@boardsesh/auth-protocol/browser-backend-session';

const control = vi.hoisted(() => ({
  client: null as ReturnType<typeof createBrowserBackendClient> | null,
  refresh: vi.fn(),
  currentSession: null as unknown,
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
  control.currentSession = current;
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

describe('pagehide commits private retirement before the next native listener', () => {
  it('retires the manager receipt and removes private DOM inside the same native event', async () => {
    renderConsumer();
    await screen.findByText('Private client:climber-a');
    let observed: { owner: unknown; receiptCurrent: boolean; privateVisible: boolean } | undefined;
    const inspectAfterProvider = () => {
      observed = {
        owner: control.client!.getSnapshot().owner,
        receiptCurrent: control.client!.isSessionCurrent(control.currentSession),
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
});
