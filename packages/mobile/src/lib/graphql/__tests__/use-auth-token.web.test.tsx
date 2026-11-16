// @vitest-environment jsdom
/**
 * Expo web's useAuthToken against a real local www (session + ws-auth) and the
 * real auth store: callers get a label for the signed-in login, never the JWE,
 * and a new login or credential generation gives them a new key (#7596).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createElement, type ReactNode } from 'react';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '2.6.0' } } }));
vi.mock('../../client-platform', () => ({ CLIENT_PLATFORM: 'web' }));

type Identity = { userId: string; authSessionId: string } | null;

const USER_A = { userId: 'user-a', authSessionId: 'login-a' };
const site = { cookie: USER_A as Identity };
let server: Server;
let origin = '';

const tokenFor = (identity: NonNullable<Identity>) => `jwe:${identity.userId}:${identity.authSessionId}`;

beforeAll(async () => {
  server = createServer((request, response) => {
    const send = (body: unknown) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.url === '/api/auth/session')
      return send(site.cookie ? { user: { id: site.cookie.userId }, authSessionId: site.cookie.authSessionId } : {});
    if (request.url === '/api/internal/ws-auth')
      return send(
        site.cookie
          ? { authenticated: true, token: tokenFor(site.cookie), ...site.cookie }
          : { authenticated: false, token: null },
      );
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

async function openPage(cookie: Identity, { readSessionFirst = true } = {}) {
  vi.resetModules();
  vi.stubEnv('EXPO_PUBLIC_WEB_URL', origin);
  vi.stubEnv('EXPO_PUBLIC_BACKEND_URL', origin);
  site.cookie = cookie;
  const store = await import('../../auth-store.web');
  const { useAuthToken } = await import('../use-auth-token.web');
  if (readSessionFirst) await store.synchronizeWebSession();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const hook = renderHook(() => useAuthToken(), { wrapper });
  await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
  return { store, hook, queryClient };
}

describe('Expo web useAuthToken', () => {
  it('gives a signed-in page a label for its login and never the backend token', async () => {
    const { store, hook, queryClient } = await openPage(USER_A);

    expect(await store.getAuthToken()).toBe(tokenFor(USER_A));
    const label = hook.result.current.data;
    expect(label).toBe(JSON.stringify([store.captureAuthCredentialGeneration(), 'user-a', 'login-a']));
    // Neither the result nor any React Query key carries the JWE.
    const cached = JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => [query.queryKey, query.state.data]),
    );
    expect(cached).not.toContain(tokenFor(USER_A));
  });

  it('reads the session itself on a cold page instead of caching signed out', async () => {
    const { store, hook } = await openPage(USER_A, { readSessionFirst: false });

    expect(hook.result.current.data).toBe(
      JSON.stringify([store.captureAuthCredentialGeneration(), 'user-a', 'login-a']),
    );
  });

  it('gives a signed-out page null, so token-gated reads stay off', async () => {
    const { hook } = await openPage(null);

    expect(hook.result.current.data).toBeNull();
  });

  it('moves callers to a new key when the same login gets a new credential generation', async () => {
    const { store, hook } = await openPage(USER_A);
    const first = hook.result.current.data;

    await store.clearTokens();
    await store.synchronizeWebSession();

    const rotated = JSON.stringify([store.captureAuthCredentialGeneration(), 'user-a', 'login-a']);
    expect(rotated).not.toBe(first);
    await waitFor(() => expect(hook.result.current.data).toBe(rotated));
  });
});
