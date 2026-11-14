// @vitest-environment node
import { createHash } from 'node:crypto';
import { encode } from 'next-auth/jwt';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { BrowserBindingCommandClient } from '../browser-binding-command-client.server';
vi.mock('server-only', () => ({}));
import { BROWSER_COORDINATOR_PATHS, createBrowserCoordinatorRoutes } from '../browser-coordinator-routes.server';
import { publicBrowserCoordinatorReady } from '../browser-coordinator-readiness';
import {
  BROWSER_CORRELATION_COOKIE,
  BROWSER_PROOF_COOKIE_PREFIX,
  readBrowserProofCookie,
} from '../browser-proof-cookies.server';
import { readBootstrapLegacyCredential } from '../browser-bootstrap-legacy.server';
import { readPresentedBrowserSelection } from '../presented-browser-selection.server';

const origin = 'https://www.boardsesh.test';
const secret = 'owned-coordinator-fixture-secret-never-production';
const bindingToken = Buffer.alloc(32, 11).toString('base64url');
const bindingId = createHash('sha256').update(bindingToken).digest('hex');
const metadata = { browserBindingProtocolVersion: 1 as const, requestId: 'e363934b-b7ba-41ba-a279-52185daa100e' };
const environment = {
  NEXTAUTH_URL: origin,
  NEXTAUTH_SECRET: secret,
  CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging',
};
const future = () => new Date(Date.now() + 3_600_000).toISOString();
function fixture() {
  const cursor = { bindingId, version: 0, bindingExpiresAt: future() };
  const session = {
    userId: 'owner-A',
    authSessionId: 'original-SID',
    generation: 4,
    authenticatedAt: null,
    expiresAt: future(),
    linkGuarded: false,
    requiresAccountCutoff: true,
  };
  const bootstrap = vi
    .fn<BrowserBindingCommandClient['bootstrap']>()
    .mockResolvedValue({ ...metadata, operation: 'bootstrap', outcome: 'created', token: bindingToken, cursor });
  const intent = vi.fn<BrowserBindingCommandClient['intent']>().mockResolvedValue({
    ...metadata,
    operation: 'intent',
    outcome: 'prepared',
    intentToken: Buffer.alloc(32, 12).toString('base64url'),
    cursor,
    expiresAt: future(),
  });
  const login = vi.fn<BrowserBindingCommandClient['login']>().mockResolvedValue({
    ...metadata,
    operation: 'login',
    outcome: 'committed',
    cursor: { ...cursor, version: 1 },
    session,
  });
  const describeBinding = vi.fn<BrowserBindingCommandClient['describe']>().mockResolvedValue({
    ...metadata,
    operation: 'describe',
    outcome: 'known',
    state: 'anonymous',
    credentialKind: null,
    cursor,
  });
  const read = vi
    .fn<BrowserBindingCommandClient['read']>()
    .mockResolvedValue({ ...metadata, operation: 'read', outcome: 'anonymous', cursor });
  const client: BrowserBindingCommandClient = {
    bootstrap,
    intent,
    login,
    describe: describeBinding,
    read,
    logout: vi.fn(),
  };
  const clientFactory = vi.fn(() => client);
  const admitLegacy = vi.fn<(credential: string) => Promise<string | null>>().mockResolvedValue('owner-A');
  const options = {
    environment,
    ready: () => true,
    clientFactory,
    admitLegacy,
    rateLimit: () => false,
    readSelection: (cookies: string | null) => readPresentedBrowserSelection(cookies, { environment, client }),
  };
  const routes = createBrowserCoordinatorRoutes(options);
  return {
    routes,
    client,
    clientFactory,
    bootstrap,
    intent,
    login,
    describeBinding,
    read,
    admitLegacy,
    options,
    cursor,
    session,
  };
}
function request(operation: keyof typeof BROWSER_COORDINATOR_PATHS, cookies?: string, overrides: RequestInit = {}) {
  const method = operation === 'observe' ? 'GET' : 'POST';
  return new Request(`http://127.0.0.1:3000${BROWSER_COORDINATOR_PATHS[operation]}`, {
    method,
    headers: {
      host: 'www.boardsesh.test',
      origin,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      ...(cookies ? { cookie: cookies } : {}),
    },
    ...(method === 'POST' ? { body: '{}' } : {}),
    ...overrides,
  });
}
function installedCookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((header) => header.split(';', 1)[0])
    .join('; ');
}
async function legacyCookie() {
  const credential = await encode({
    secret,
    token: { sub: 'owner-A', sid: 'original-SID', gen: 4, authTime: null },
    maxAge: 3_600,
  });
  return { credential, cookie: `__Secure-next-auth.session-token=${credential}` };
}
describe('canonical browser bootstrap routes', () => {
  it('keeps both public exports dark before any source or private command work', async () => {
    const current = fixture();
    const routes = createBrowserCoordinatorRoutes({ ...current.options, ready: undefined });
    expect(publicBrowserCoordinatorReady()).toBe(false);
    for (const operation of ['observe', 'initialize'] as const)
      expect((await routes[operation](request(operation))).status).toBe(503);
    expect(current.clientFactory).not.toHaveBeenCalled();
    expect(current.admitLegacy).not.toHaveBeenCalled();
  });
  it('observes a missing binding without mutation or credential disclosure', async () => {
    const current = fixture();
    const { cookie } = await legacyCookie();
    const response = await current.routes.observe(request('observe', cookie));
    expect(await response.json()).toEqual({ status: 'missing-binding' });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(current.bootstrap).not.toHaveBeenCalled();
  });
  it('publishes one anonymous correlation and reuses it on the next read/initialize', async () => {
    const current = fixture();
    const created = await current.routes.initialize(request('initialize'));
    expect(await created.json()).toEqual({ status: 'ready', cursor: { bindingId, version: 0 } });
    const installed = installedCookies(created);
    expect(installed).toBe(`${BROWSER_CORRELATION_COOKIE}=${bindingToken}`);
    expect(created.headers.getSetCookie()[0]).toContain('Path=/; HttpOnly; Secure; SameSite=Lax');
    expect(created.headers.getSetCookie()[0]).not.toContain('Domain=');
    for (const operation of ['observe', 'initialize'] as const) {
      const reused = await current.routes[operation](request(operation, installed));
      expect(await reused.json()).toEqual({ status: 'ready', cursor: { bindingId, version: 0 } });
      expect(reused.headers.getSetCookie()).toEqual([]);
    }
    expect(current.bootstrap).toHaveBeenCalledTimes(1);
    expect(current.login).not.toHaveBeenCalled();
  });
  it('carries the exact existing JWE into v1 proof and backend login without credential rotation', async () => {
    const current = fixture();
    // The backend expiry is bounded by the second-rounded actual JWE expiry.
    current.session.expiresAt = new Date(Math.floor(Date.now() / 1_000) * 1_000 + 3_500_000).toISOString();
    const { cookie, credential } = await legacyCookie();
    const response = await current.routes.initialize(request('initialize', cookie));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready', cursor: { bindingId, version: 1 } });
    const proof = readBrowserProofCookie(installedCookies(response), { bindingId, version: 1 });
    expect(proof).toEqual({ status: 'present', proof: { kind: 'legacy-jwe', rawCredential: credential } });
    expect(current.admitLegacy).toHaveBeenCalledExactlyOnceWith(credential);
    expect(current.login.mock.calls[0][0].candidate).toEqual({ kind: 'legacy-jwe', credential });
    expect(current.intent.mock.calls[0][0]).toEqual({ bindingToken, transition: 'login', expectedVersion: 0 });
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(JSON.stringify(await (await current.routes.observe(request('observe'))).json())).not.toContain('owner-A');
  });
  it.each(['denied', 'unavailable', 'expired'] as const)(
    'does not create anonymous state over a %s legacy account',
    async (failure) => {
      const current = fixture();
      const { cookie } = await legacyCookie();
      if (failure === 'denied') current.admitLegacy.mockResolvedValue(null);
      if (failure === 'unavailable') current.admitLegacy.mockRejectedValue(new Error('private transport cause'));
      const routes =
        failure === 'expired'
          ? createBrowserCoordinatorRoutes({ ...current.options, legacyExpiry: async () => Date.now() - 1 })
          : current.routes;
      const response = await routes.initialize(request('initialize', cookie));
      expect(response.status).toBe(failure === 'unavailable' ? 503 : 409);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(current.bootstrap).not.toHaveBeenCalled();
    },
  );
  it.each([
    `${BROWSER_PROOF_COOKIE_PREFIX}${'a'.repeat(64)}.2=orphan`,
    `${BROWSER_PROOF_COOKIE_PREFIX}malformed=x`,
    `${BROWSER_CORRELATION_COOKIE}=bad`,
    '__Secure-next-auth.session-token=a; next-auth.session-token=b',
    '__Secure-next-auth.session-token.1=gap',
    '__Secure-next-auth.session-token=a; __Secure-next-auth.session-token=a',
  ])('refuses reserved/ambiguous material before bootstrap: %s', async (cookie) => {
    const current = fixture();
    const response = await current.routes.initialize(request('initialize', cookie));
    expect(response.status).not.toBe(200);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(current.bootstrap).not.toHaveBeenCalled();
  });
  it.each(['unavailable', 'denied', 'conflict', 'proof-required'] as const)(
    'never initializes a present %s selection',
    async (status) => {
      const current = fixture();
      const routes = createBrowserCoordinatorRoutes({ ...current.options, readSelection: async () => ({ status }) });
      const response = await routes.initialize(request('initialize'));
      expect(response.status).toBe(status === 'unavailable' ? 503 : 409);
      expect(current.bootstrap).not.toHaveBeenCalled();
    },
  );
  it('checks whole future Cookie capacity before login mutation', async () => {
    const current = fixture();
    const { cookie } = await legacyCookie();
    const response = await current.routes.initialize(request('initialize', `${cookie}; other=${'x'.repeat(7_400)}`));
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(current.intent).not.toHaveBeenCalled();
    expect(current.login).not.toHaveBeenCalled();
  });
  it('withholds every candidate header after an unknown commit and never retries it', async () => {
    const current = fixture();
    current.login.mockRejectedValue(new Error('commit outcome unknown'));
    const { cookie } = await legacyCookie();
    const response = await current.routes.initialize(request('initialize', cookie));
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(current.login).toHaveBeenCalledTimes(1);
  });
  it.each(['host', 'origin', 'fetch-site', 'body', 'rate', 'aborted'] as const)(
    'rejects %s before private work',
    async (failure) => {
      const current = fixture();
      const incoming = request('initialize');
      if (failure === 'host') incoming.headers.set('host', 'app.boardsesh.test');
      if (failure === 'origin') incoming.headers.set('origin', 'https://other.test');
      if (failure === 'fetch-site') incoming.headers.set('sec-fetch-site', 'same-site');
      let selected = incoming;
      if (failure === 'body') selected = request('initialize', undefined, { body: '{"credential":"claimed"}' });
      if (failure === 'aborted') selected = request('initialize', undefined, { signal: AbortSignal.abort() });
      const routes =
        failure === 'rate'
          ? createBrowserCoordinatorRoutes({ ...current.options, rateLimit: () => true })
          : current.routes;
      expect((await routes.initialize(selected)).status).not.toBe(200);
      expect(current.bootstrap).not.toHaveBeenCalled();
    },
  );
  it('reconstructs only a complete unique legacy family, including numbered chunks', () => {
    expect(readBootstrapLegacyCredential('other=x')).toBeNull();
    expect(readBootstrapLegacyCredential('next-auth.session-token.1=c; next-auth.session-token.0=ab')).toBe('abc');
    expect(() => readBootstrapLegacyCredential('next-auth.session-token.00=ab')).toThrow();
    expect(() => readBootstrapLegacyCredential('next-auth.session-token=a; next-auth.session-token.0=b')).toThrow();
  });
});
