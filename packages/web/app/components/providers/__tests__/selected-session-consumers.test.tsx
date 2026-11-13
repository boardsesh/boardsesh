import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useQuery } from '@tanstack/react-query';
import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserBackendClient } from '@/app/lib/auth/browser-backend-client';
import {
  browserBackendSessionKey,
  readBrowserBackendSessionScope,
} from '@boardsesh/auth-protocol/browser-backend-session';
import { beginWebSessionIntent, requestWebSessionRefresh } from '@/app/lib/auth/web-session-events';
import { CNC_CONFIGURATOR_DRAFT_KEY } from '@/app/build-plans/configurator/configurator-state';

const fixture = vi.hoisted(() => ({
  client: null as ReturnType<typeof createBrowserBackendClient> | null,
  persisted: undefined as PersistedClient | undefined,
  restores: 0,
  writes: [] as PersistedClient[],
  readPrivate: vi.fn<(scope: string) => Promise<string>>(),
  localOperation: vi.fn<() => Promise<string>>(),
  removePreference: vi.fn<(key: string) => Promise<void>>(),
}));
vi.mock('@/app/lib/auth/browser-backend-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/app/lib/auth/browser-backend-client')>();
  return {
    ...original,
    browserBackendClient: new Proxy(original.browserBackendClient, {
      get(_target, property) {
        return Reflect.get(fixture.client ?? original.browserBackendClient, property);
      },
    }),
  };
});
vi.mock('@/app/lib/auth/browser-consumer-readiness', () => ({ publicBrowserConsumersReady: () => true }));
vi.mock('@/app/lib/user-preferences-db', () => ({ removePreference: fixture.removePreference }));
// Isolate the response-publication barrier with an abort-ignoring transport.
// The origin lock's abort-settlement ordering has its own unchanged suite.
vi.mock('@/app/lib/auth/nextauth-cookie-fetch-lock', () => ({ installNextAuthCookieFetchLock: () => {} }));
vi.mock('@/app/lib/react-query-idb-persister', () => ({
  PERSIST_MAX_AGE_MS: 86_400_000,
  createIdbPersister: () => ({
    persistClient: async (client: PersistedClient) => {
      fixture.writes.push(client);
      fixture.persisted = client;
    },
    restoreClient: async () => {
      fixture.restores += 1;
      return fixture.persisted;
    },
    removeClient: async () => {
      fixture.persisted = undefined;
    },
  }),
}));
import SessionProviderWrapper from '../session-provider';
import QueryClientProvider from '../query-client-provider';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';

function owner() {
  return {
    userId: 'owned-user-A',
    authSessionId: 'owned-login-A',
    generation: 0,
    cursor: { bindingId: 'a'.repeat(64), version: 1 },
  };
}
function session(scope = owner()) {
  return {
    user: { id: scope.userId },
    authSessionId: scope.authSessionId,
    authGeneration: scope.generation,
    expires: '2099-01-01T00:00:00.000Z',
    browserSelection: scope,
  };
}
type OwnedSession = ReturnType<typeof session>;
function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
let serverSession: OwnedSession | null;
let readSession: ReturnType<typeof vi.fn<() => Promise<Response>>>;
let leaseFetch: ReturnType<typeof vi.fn<typeof fetch>>;

function OwnedConsumer() {
  const { data: current, status } = useSession();
  const observed = readBrowserBackendSessionScope(current);
  const scope = observed.status === 'selected' ? browserBackendSessionKey(observed.owner) : 'none';
  const [draft, setDraft] = useState('empty');
  const [localResult, setLocalResult] = useState('none');
  const { token } = useWsAuthToken();
  const privateQuery = useQuery({
    queryKey: ['owned-private-viewer'],
    queryFn: () => fixture.readPrivate(scope),
    enabled: status === 'authenticated',
    meta: { persist: true },
  });
  return (
    <>
      <output data-testid="owner">{scope}</output>
      <output data-testid="session-status">{status}</output>
      <output data-testid="draft">{draft}</output>
      <output data-testid="local-result">{localResult}</output>
      <output data-testid="private-query">{privateQuery.data ?? 'none'}</output>
      <output data-testid="lease">{token ? 'admitted' : 'none'}</output>
      <button onClick={() => setDraft('private draft')}>Edit draft</button>
      <button
        onClick={() => {
          void fixture.localOperation().then(setLocalResult);
        }}
      >
        Start owned operation
      </button>
    </>
  );
}
function renderConsumers() {
  return render(
    <SessionProviderWrapper>
      <QueryClientProvider>
        <OwnedConsumer />
      </QueryClientProvider>
    </SessionProviderWrapper>,
  );
}
async function confirm(next: OwnedSession | null) {
  serverSession = next;
  act(() => {
    requestWebSessionRefresh(beginWebSessionIntent());
  });
  await waitFor(() =>
    expect(screen.getByTestId('owner').textContent).toBe(
      next ? browserBackendSessionKey(next.browserSelection) : 'none',
    ),
  );
}

beforeEach(() => {
  delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[
    Symbol.for('boardsesh.nextauth-cookie-fetch-lock.state-v1')
  ];
  fixture.persisted = undefined;
  fixture.restores = 0;
  fixture.writes = [];
  fixture.readPrivate.mockReset().mockImplementation(async (scope) => `private:${scope}`);
  fixture.localOperation.mockReset().mockResolvedValue('owned-completion');
  fixture.removePreference.mockReset().mockResolvedValue(undefined);
  serverSession = session();
  readSession = vi.fn(async () => Response.json(serverSession ?? {}));
  leaseFetch = vi.fn<typeof fetch>(async () =>
    serverSession
      ? Response.json({
          status: 'admitted',
          token: `bsbd1_OWNED${serverSession.browserSelection.cursor.version}`,
          usableForMs: 120_000,
          owner: serverSession.browserSelection,
        })
      : Response.json({ status: 'denied' }, { status: 401 }),
  );
  fixture.client = createBrowserBackendClient({
    ready: () => true,
    fetch: leaseFetch,
    endpoint: 'https://www.owned.test/api/internal/ws-auth',
    now: () => performance.now(),
    schedule(callback, milliseconds) {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => readSession()),
  );
});
afterEach(() => {
  cleanup();
  fixture.client?.dispose();
  fixture.client = null;
  vi.useRealTimers();
  delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[
    Symbol.for('boardsesh.nextauth-cookie-fetch-lock.state-v1')
  ];
  vi.unstubAllGlobals();
});

describe('selected WWW session, hook and private client subtree', () => {
  it.each(['UID', 'SID', 'generation', 'version'] as const)(
    'clears prior local/cache state before exposing a changed %s',
    async (change) => {
      renderConsumers();
      await waitFor(() => expect(screen.getByTestId('lease').textContent).toBe('admitted'));
      fireEvent.click(screen.getByText('Edit draft'));
      expect(screen.getByTestId('draft').textContent).toBe('private draft');
      const next = owner();
      if (change === 'UID') next.userId = 'owned-user-B';
      if (change === 'SID') next.authSessionId = 'same-user-new-login';
      if (change === 'generation') next.generation = 1;
      next.cursor.version += 1;
      const key = browserBackendSessionKey(next);
      await confirm(session(next));
      expect(screen.getByTestId('draft').textContent).toBe('empty');
      await waitFor(() => expect(screen.getByTestId('private-query').textContent).toBe(`private:${key}`));
      expect(fixture.persisted?.buster).toBe(key);
      expect(fixture.persisted?.clientState.queries.some((query) => query.queryKey[0] === 'wsAuthToken')).toBe(false);
      if (change === 'UID')
        expect(fixture.removePreference).toHaveBeenCalledExactlyOnceWith(CNC_CONFIGURATOR_DRAFT_KEY);
      else expect(fixture.removePreference).not.toHaveBeenCalled();
    },
  );
  it('old local operation completion cannot populate B after its A component unmounts', async () => {
    const operation = deferred<string>();
    fixture.localOperation.mockReturnValueOnce(operation.promise);
    renderConsumers();
    await waitFor(() => expect(screen.getByTestId('lease').textContent).toBe('admitted'));
    fireEvent.click(screen.getByText('Start owned operation'));
    await confirm(session({ ...owner(), userId: 'owned-user-B', cursor: { ...owner().cursor, version: 2 } }));
    await act(async () => operation.resolve('private-A-completion'));
    expect(screen.getByTestId('local-result').textContent).toBe('none');
  });
  it('A to B to A never resurrects the original A component or delayed private query', async () => {
    const pending = deferred<string>();
    fixture.readPrivate.mockImplementationOnce(async () => pending.promise);
    renderConsumers();
    await waitFor(() => expect(fixture.readPrivate).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText('Edit draft'));
    await confirm(session({ ...owner(), userId: 'owned-user-B', cursor: { ...owner().cursor, version: 2 } }));
    await confirm(session({ ...owner(), cursor: { ...owner().cursor, version: 3 } }));
    const finalKey = browserBackendSessionKey({ ...owner(), cursor: { ...owner().cursor, version: 3 } });
    await waitFor(() => expect(screen.getByTestId('private-query').textContent).toBe(`private:${finalKey}`));
    await act(async () => pending.resolve('private-original-A'));
    expect(screen.getByTestId('draft').textContent).toBe('empty');
    expect(screen.getByTestId('private-query').textContent).toBe(`private:${finalKey}`);
  });
  it('a late A session response cannot remount A or reacquire its lease after B', async () => {
    renderConsumers();
    await waitFor(() => expect(screen.getByTestId('lease').textContent).toBe('admitted'));
    const pending = deferred<Response>();
    readSession.mockImplementationOnce(async () => pending.promise);
    act(() => requestWebSessionRefresh(beginWebSessionIntent()));
    await waitFor(() => expect(readSession).toHaveBeenCalledTimes(2));
    const next = { ...owner(), userId: 'owned-user-B', cursor: { ...owner().cursor, version: 2 } };
    await confirm(session(next));
    await act(async () => pending.resolve(Response.json(session())));
    expect(screen.getByTestId('owner').textContent).toBe(browserBackendSessionKey(next));
    expect(fixture.client?.getSnapshot().owner).toEqual(next);
  });
  it('does not restore another private persisted scope while the initial session is still pending', async () => {
    fixture.persisted = {
      timestamp: Date.now(),
      buster: browserBackendSessionKey(owner()),
      clientState: { mutations: [], queries: [] },
    };
    const pending = deferred<Response>();
    readSession.mockImplementationOnce(async () => pending.promise);
    renderConsumers();
    await waitFor(() => expect(readSession).toHaveBeenCalledTimes(1));
    expect(fixture.restores).toBe(0);
    const next = { ...owner(), userId: 'owned-user-B', cursor: { ...owner().cursor, version: 2 } };
    serverSession = session(next);
    await act(async () => pending.resolve(Response.json(serverSession)));
    await waitFor(() =>
      expect(screen.getByTestId('private-query').textContent).toBe(`private:${browserBackendSessionKey(next)}`),
    );
    expect(fixture.persisted?.buster).toBe(browserBackendSessionKey(next));
  });
  it('preserves the inherited CNC draft cleanup on selected sign-out', async () => {
    renderConsumers();
    await waitFor(() => expect(screen.getByTestId('lease').textContent).toBe('admitted'));
    await confirm(null);
    expect(fixture.removePreference).toHaveBeenCalledExactlyOnceWith(CNC_CONFIGURATOR_DRAFT_KEY);
  });
  it('preserves an anonymous CNC draft through first sign-in', async () => {
    serverSession = null;
    renderConsumers();
    await waitFor(() => expect(screen.getByTestId('session-status').textContent).toBe('unauthenticated'));
    await confirm(session());
    await waitFor(() => expect(screen.getByTestId('lease').textContent).toBe('admitted'));
    expect(fixture.removePreference).not.toHaveBeenCalled();
  });
  it('newer account publication waits for an older delayed CNC deletion before creating its draft', async () => {
    const deletion = deferred<void>();
    let storedDraft: string | null = 'private-A-draft';
    fixture.removePreference
      .mockImplementationOnce(async () => {
        await deletion.promise;
        storedDraft = null;
      })
      .mockImplementation(async () => {
        storedDraft = null;
      });
    renderConsumers();
    await waitFor(() => expect(screen.getByTestId('lease').textContent).toBe('admitted'));
    serverSession = session({ ...owner(), userId: 'owned-user-B', cursor: { ...owner().cursor, version: 2 } });
    act(() => requestWebSessionRefresh(beginWebSessionIntent()));
    await waitFor(() => expect(fixture.removePreference).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('owner').textContent).toBe(browserBackendSessionKey(owner()));
    const next = { ...owner(), userId: 'owned-user-C', cursor: { ...owner().cursor, version: 3 } };
    serverSession = session(next);
    act(() => requestWebSessionRefresh(beginWebSessionIntent()));
    await waitFor(() => expect(fixture.client?.getSnapshot().owner).toEqual(next));
    expect(screen.getByTestId('owner').textContent).toBe(browserBackendSessionKey(owner()));
    await act(async () => deletion.resolve());
    await waitFor(() => expect(screen.getByTestId('owner').textContent).toBe(browserBackendSessionKey(next)));
    expect(fixture.removePreference).toHaveBeenCalledTimes(2);
    expect(storedDraft).toBeNull();
    storedDraft = 'current-C-draft';
    await act(async () => {
      await Promise.resolve();
    });
    expect(storedDraft).toBe('current-C-draft');
  });
  it('A to B to a new A login also joins pending deletion instead of bypassing the cleanup barrier', async () => {
    const deletion = deferred<void>();
    fixture.removePreference.mockImplementationOnce(async () => deletion.promise);
    renderConsumers();
    await waitFor(() => expect(screen.getByTestId('lease').textContent).toBe('admitted'));
    serverSession = session({ ...owner(), userId: 'owned-user-B', cursor: { ...owner().cursor, version: 2 } });
    act(() => requestWebSessionRefresh(beginWebSessionIntent()));
    await waitFor(() => expect(fixture.removePreference).toHaveBeenCalledTimes(1));
    const next = { ...owner(), authSessionId: 'new-owned-login-A', cursor: { ...owner().cursor, version: 3 } };
    serverSession = session(next);
    act(() => requestWebSessionRefresh(beginWebSessionIntent()));
    await waitFor(() => expect(fixture.client?.getSnapshot().owner).toEqual(next));
    expect(screen.getByTestId('owner').textContent).toBe(browserBackendSessionKey(owner()));
    await act(async () => deletion.resolve());
    await waitFor(() => expect(screen.getByTestId('owner').textContent).toBe(browserBackendSessionKey(next)));
    expect(fixture.removePreference).toHaveBeenCalledTimes(1);
    expect(fixture.client?.getSnapshot().owner).toEqual(next);
  });
  it('re-reads the current session after cleanup outlives a request deadline, without publishing the expired response', async () => {
    const deletion = deferred<void>();
    fixture.removePreference.mockImplementationOnce(async () => deletion.promise);
    renderConsumers();
    await waitFor(() => expect(screen.getByTestId('lease').textContent).toBe('admitted'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const next = { ...owner(), userId: 'owned-user-B', cursor: { ...owner().cursor, version: 2 } };
    serverSession = session(next);
    act(() => requestWebSessionRefresh(beginWebSessionIntent()));
    await vi.waitFor(() => expect(fixture.removePreference).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_001);
    });
    expect(screen.getByTestId('owner').textContent).toBe(browserBackendSessionKey(owner()));
    vi.useRealTimers();
    await act(async () => deletion.resolve());
    await waitFor(() => expect(screen.getByTestId('owner').textContent).toBe(browserBackendSessionKey(next)));
    expect(readSession).toHaveBeenCalledTimes(3);
  });
});
