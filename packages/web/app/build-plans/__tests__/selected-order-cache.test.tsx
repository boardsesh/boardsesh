import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionContext, type SessionContextValue } from 'next-auth/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserBackendClient } from '@boardsesh/auth-protocol/browser-backend-client';
import type { Session } from 'next-auth';

const control = vi.hoisted(() => ({
  client: null as ReturnType<typeof createBrowserBackendClient> | null,
  token: null as string | null,
  readGraphQL: vi.fn<typeof fetch>(),
  routeRefresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: control.routeRefresh }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/app/hooks/use-ws-auth-token', () => ({ useWsAuthToken: () => ({ token: control.token }) }));
vi.mock('@/app/components/i18n/locale-link', () => ({ default: 'test-link' }));
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
vi.mock('@/app/lib/graphql/client', async () => {
  const { GraphQLClient } = await import('graphql-request');
  const { browserBackendClient } = await import('@/app/lib/auth/browser-backend-client');
  const { captureBrowserBackendRequestScope, createBrowserBackendGraphQLTransport } =
    await import('@/app/lib/auth/browser-backend-graphql');
  return {
    createGraphQLHttpClient(authToken?: string | null) {
      const scope = captureBrowserBackendRequestScope(authToken, browserBackendClient);
      if (!scope) throw new Error('Owned selected scope required');
      return new GraphQLClient(
        'https://backend.example.test/graphql',
        createBrowserBackendGraphQLTransport({ client: browserBackendClient, scope, fetch: control.readGraphQL }),
      );
    },
  };
});
vi.mock('../orders/[licenceId]/order-status', () => ({
  default: ({ initialOrder }: { initialOrder: { licenseeName: string } }) => <p>{initialOrder.licenseeName}</p>,
}));
import { SelectedOrderDetail } from '../orders/selected-orders';
import { useCncBrowserScope } from '../use-cnc-browser-scope';
import SelectedPrivateView from '@/app/components/auth/selected-private-view';
import { WEB_SESSION_REFRESH_EVENT } from '@/app/lib/auth/web-session-events';

function owner() {
  return {
    userId: 'buyer-a',
    authSessionId: 'buyer-login-a',
    generation: 1,
    cursor: { bindingId: 'a'.repeat(64), version: 1 },
  };
}
function session() {
  return {
    user: { id: owner().userId },
    authSessionId: owner().authSessionId,
    authGeneration: owner().generation,
    expires: '2099-01-01T00:00:00.000Z',
    browserSelection: owner(),
  };
}
function response(licenseeName: string) {
  return Response.json({
    data: { cncOrder: { licenceId: 'BS-CNC-K7QM3T', licenseeName, boardName: 'kilter', layoutId: 8, sizeId: 25 } },
  });
}
let queryClient: QueryClient;
function view(current: Session) {
  const context: SessionContextValue = { data: current, status: 'authenticated', update: async () => current };
  return (
    <SessionContext.Provider value={context}>
      <QueryClientProvider client={queryClient}>
        <SelectedOrderDetail
          owner={owner()}
          licenceId="BS-CNC-K7QM3T"
          catalog={null}
          locale="en-US"
          checkoutOutcome={null}
        />
      </QueryClientProvider>
    </SessionContext.Provider>
  );
}
beforeEach(async () => {
  let issued = 0;
  control.client = createBrowserBackendClient({
    ready: () => true,
    fetch: vi.fn<typeof fetch>(async () =>
      Response.json({ status: 'admitted', token: `bsbd1_OWNED${++issued}`, usableForMs: 120_000, owner: owner() }),
    ),
    endpoint: '/owned-lease',
    now: () => 0,
    schedule: () => () => {},
  });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  control.readGraphQL.mockReset().mockImplementation(async () => response('Private first receipt'));
  control.routeRefresh.mockReset();
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  control.client?.dispose();
  control.client = null;
});

describe('selected order caches cannot resurrect an invalidated receipt', () => {
  it('fetches a new order after actual same-tuple re-admission, without flashing the old cached value', async () => {
    const first = session();
    control.client!.acceptSession(first);
    const firstLease = await control.client!.acquire(owner());
    control.token = firstLease.token;
    const { rerender } = render(view(first));
    await screen.findByText('Private first receipt');
    act(() => control.client!.invalidate(control.client!.capture(firstLease.token)!));
    expect(screen.queryByText('Private first receipt')).toBeNull();
    let finish!: (response: Response) => void;
    control.readGraphQL.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const admittedAgain = session();
    act(() => {
      control.client!.acceptSession(admittedAgain);
    });
    await act(async () => {
      control.token = (await control.client!.acquire(owner())).token;
    });
    rerender(view(admittedAgain));
    expect(screen.queryByText('Private first receipt')).toBeNull();
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    await act(async () => finish(response('Private fresh receipt')));
    await screen.findByText('Private fresh receipt');
    expect(control.readGraphQL).toHaveBeenCalledTimes(2);
  });
  it('hides a copied or retired Session object and changes cache scope on exact-tuple re-admission', () => {
    const first = session();
    control.client!.acceptSession(first);
    const { result, rerender } = renderHook(({ current }) => useCncBrowserScope(current), {
      initialProps: { current: first },
    });
    const firstKey = result.current;
    expect(typeof firstKey).toBe('string');
    rerender({ current: structuredClone(first) });
    expect(result.current).toBeNull();
    rerender({ current: first });
    expect(result.current).toBe(firstKey);
    act(() => control.client!.retire());
    expect(result.current).toBeNull();
    const admittedAgain = session();
    act(() => {
      control.client!.acceptSession(admittedAgain);
    });
    rerender({ current: admittedAgain });
    expect(typeof result.current).toBe('string');
    expect(result.current).not.toBe(firstKey);
  });
  it('coalesces central recovery with another private island and does not supersede admitted B', () => {
    const first = session();
    control.client!.acceptSession(first);
    const refresh = vi.fn();
    window.addEventListener(WEB_SESSION_REFRESH_EVENT, refresh);
    function ScopeProbe() {
      const key = useCncBrowserScope(first);
      return <output>{key ?? 'hidden'}</output>;
    }
    const context: SessionContextValue = { data: first, status: 'authenticated', update: async () => first };
    try {
      render(
        <SessionContext.Provider value={context}>
          <ScopeProbe />
          <SelectedPrivateView expectedOwner={owner()}>
            <p>Owned private view</p>
          </SelectedPrivateView>
        </SessionContext.Provider>,
      );
      act(() => control.client!.retire());
      expect(refresh).toHaveBeenCalledOnce();
      const next = session();
      next.user.id = 'buyer-b';
      next.browserSelection.userId = 'buyer-b';
      act(() => {
        control.client!.acceptSession(next);
      });
      expect(refresh).toHaveBeenCalledOnce();
      expect(screen.queryByText('Owned private view')).toBeNull();
    } finally {
      window.removeEventListener(WEB_SESSION_REFRESH_EVENT, refresh);
    }
  });
});
