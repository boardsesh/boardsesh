// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GoogleProvider from 'next-auth/providers/google';
import type { NextAuthOptions } from 'next-auth';
import { encode } from 'next-auth/jwt';
import { NextRequest } from 'next/server';
import type { WebOAuthIntentCommand } from '@boardsesh/auth-protocol';

const rpc = vi.hoisted(() => ({ intent: vi.fn(), resolve: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('../web-oauth-command-client.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web-oauth-command-client.server')>()),
  createWebOAuthCommandClient: () => rpc,
}));
import { createWebOAuthIdentityAuthRequest } from '../web-oauth-auth.server';
import { withWebOAuthIdentity } from '../web-oauth-request.server';

const origin = 'https://owned.example.test';
const secret = randomBytes(32).toString('base64url');
const sessionName = '__Secure-next-auth.session-token';
const flowKeys = ['state', 'pkceCodeVerifier', 'nonce', 'callbackUrl'] as const;
const attributes = { httpOnly: true, secure: true, sameSite: 'none' as const, path: '/', domain: '.example.test' };
const base: NextAuthOptions = {
  providers: [GoogleProvider({ clientId: 'owned-client', clientSecret: 'owned-client-secret' })],
  secret,
  session: { strategy: 'jwt' },
  adapter: {},
  cookies: {
    state: { name: '__Secure-next-auth.state', options: { ...attributes, maxAge: 900 } },
    pkceCodeVerifier: { name: '__Secure-next-auth.pkce.code_verifier', options: { ...attributes, maxAge: 900 } },
    nonce: { name: '__Secure-next-auth.nonce', options: { ...attributes, maxAge: 900 } },
    callbackUrl: { name: '__Secure-next-auth.callback-url', options: { ...attributes, maxAge: 30 * 86400 } },
    sessionToken: { name: sessionName, options: { ...attributes, sameSite: 'lax' } },
  },
};

/** Generic Set-Cookie consumer only; it does not know the product's scope rules. */
class CookieJar {
  readonly contents = new Map<string, string>();
  header() {
    return [...this.contents].map(([name, content]) => `${name}=${content}`).join('; ');
  }
  remember(response: Response) {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';')[0];
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      if (/;\s*Max-Age=0(?:;|$)/i.test(header)) this.contents.delete(name);
      else this.contents.set(name, pair.slice(separator + 1));
    }
  }
}

type Invocation = Parameters<typeof withWebOAuthIdentity>[3];
type Flow = { state: string; scope: string; names: string[]; response: Response };
let terminal: 'completed' | 'unavailable' | 'throw';
let callbackInvocations = 0;
let callbackUrlMaxAge: number | undefined;
let clientAddress: string;
let nextClientOctet = 1;
const privateErrorMarker = 'owned-private-rpc-failure-marker';

const invoke: Invocation = async (request, options) => {
  if (request.nextUrl.pathname.startsWith('/api/auth/signin/')) {
    const state = randomBytes(24).toString('base64url');
    const stateName = options.cookies?.state?.name;
    if (!stateName) throw new Error('Missing owned scoped state name');
    const stateToken = await encode({
      token: { value: state, provider: 'google' },
      secret,
      salt: stateName,
      maxAge: 900,
    });
    const location = new URL('https://provider.example.test/authorize');
    location.searchParams.set('state', state);
    const response = new Response(null, { status: 302, headers: { Location: location.href } });
    for (const key of flowKeys) {
      const cookie = options.cookies?.[key];
      if (!cookie) throw new Error('Missing owned flow cookie');
      if (key === 'callbackUrl') callbackUrlMaxAge = cookie.options.maxAge;
      const content = key === 'state' ? stateToken : `owned-${key}`;
      response.headers.append(
        'Set-Cookie',
        `${cookie.name}=${content}; Path=/; Domain=.example.test; HttpOnly; Secure; SameSite=None; Max-Age=${cookie.options.maxAge ?? 900}`,
      );
    }
    return response;
  }
  callbackInvocations += 1;
  if (terminal === 'throw') throw new Error(privateErrorMarker);
  if (terminal === 'unavailable') {
    try {
      await options.callbacks?.signIn?.({
        user: { id: 'provider-profile-id', name: 'Owned climber', email: 'owned@example.test' },
        account: { provider: 'google', type: 'oauth', providerAccountId: 'owned-provider-subject' },
        profile: { sub: 'owned-provider-subject', email: 'owned@example.test' },
      });
    } catch {
      // This represents the public handler's fixed error redirect after signIn.
      return new Response(null, {
        status: 302,
        headers: { Location: `${origin}/auth/error?error=AuthBackendUnavailable` },
      });
    }
    throw new Error('Expected the controlled private RPC failure');
  }
  // A controlled completed handler response tests wrapper cookie retirement,
  // not provider verification or positive identity/session publication.
  return new Response(null, { status: 302, headers: { Location: `${origin}/signed-in` } });
};

function signIn(jar: CookieJar, forwardedFor = clientAddress, handler: Invocation = invoke, requestOrigin = origin) {
  const request = new NextRequest(`${requestOrigin}/api/auth/signin/google`, {
    method: 'POST',
    headers: {
      Cookie: jar.header(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Forwarded-For': forwardedFor,
    },
    body: 'csrfToken=owned-controlled-invoke',
  });
  return withWebOAuthIdentity(request, { params: Promise.resolve({ nextauth: ['signin', 'google'] }) }, base, handler);
}

async function start(jar: CookieJar, forwardedFor = clientAddress): Promise<Flow> {
  const response = await signIn(jar, forwardedFor);
  const location = response.headers.get('Location');
  if (response.status !== 302 || !location) throw new Error('Owned flow initiation was unexpectedly denied');
  const state = new URL(location).searchParams.get('state');
  if (!state) throw new Error('Missing controlled authorization state');
  const stateHeader = response.headers
    .getSetCookie()
    .find((header) => header.startsWith(`${base.cookies!.state!.name}.`));
  if (!stateHeader) throw new Error('Missing returned signed state cookie');
  const scopedStateName = stateHeader.slice(0, stateHeader.indexOf('='));
  const scope = scopedStateName.slice(base.cookies!.state!.name.length + 1);
  jar.remember(response);
  return { state, scope, names: flowKeys.map((key) => `${base.cookies![key]!.name}.${scope}`), response };
}

async function callback(jar: CookieJar, flow: Flow, cookie = jar.header(), state = flow.state) {
  const request = new NextRequest(
    `${origin}/api/auth/callback/google?state=${encodeURIComponent(state)}&code=owned-controlled-code`,
    {
      headers: { Cookie: cookie },
    },
  );
  const response = await withWebOAuthIdentity(
    request,
    { params: Promise.resolve({ nextauth: ['callback', 'google'] }) },
    base,
    invoke,
  );
  jar.remember(response);
  return response;
}
function deletionNames(response: Response) {
  return response.headers
    .getSetCookie()
    .filter((header) => /;\s*Max-Age=0(?:;|$)/i.test(header))
    .map((header) => header.slice(0, header.indexOf('=')));
}
async function seedCurrentSession(jar: CookieJar, chunks = false) {
  const token = await encode({ token: { sub: randomUUID(), authSessionId: randomUUID() }, secret });
  if (chunks) {
    const middle = Math.floor(token.length / 2);
    jar.contents.set(`${sessionName}.0`, token.slice(0, middle));
    jar.contents.set(`${sessionName}.1`, token.slice(middle));
  } else jar.contents.set(sessionName, token);
  return [...jar.contents].filter(([name]) => name.startsWith(sessionName));
}
function expectSessionUnchanged(jar: CookieJar, prior: [string, string][]) {
  expect(prior.every(([name, content]) => jar.contents.get(name) === content)).toBe(true);
  expect([...jar.contents.keys()].filter((name) => name.startsWith(sessionName)).length).toBe(prior.length);
}

beforeEach(() => {
  vi.stubEnv('CURRENT_STORE_WEB_OAUTH_MODE', 'backend-staging');
  // A distinct address per case keeps the real per-client start limit in play.
  clientAddress = `198.51.100.${nextClientOctet++}`;
  vi.stubEnv('NEXTAUTH_URL', origin);
  terminal = 'completed';
  callbackInvocations = 0;
  callbackUrlMaxAge = undefined;
  rpc.intent.mockReset();
  rpc.resolve.mockReset();
  rpc.intent.mockImplementation(async (payload: WebOAuthIntentCommand['payload']) => ({
    webOAuthProtocolVersion: 1,
    operation: 'intent',
    requestId: randomUUID(),
    outcome: 'recorded',
    flow: payload.flow,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
  }));
  rpc.resolve.mockRejectedValue(new Error(privateErrorMarker));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('abandoned sign-ins at the two-flow cap', () => {
  const stateCookieName = (scope: string) => `${base.cookies!.state!.name}.${scope}`;
  async function twoAbandonedFlows(jar: CookieJar) {
    vi.useFakeTimers({ toFake: ['Date'] });
    const oldest = await start(jar);
    vi.setSystemTime(Date.now() + 5000);
    const newest = await start(jar);
    vi.setSystemTime(Date.now() + 5000);
    return { oldest, newest };
  }

  it('retires the oldest abandoned flow so the next sign-in still starts', async () => {
    const jar = new CookieJar();
    const session = await seedCurrentSession(jar, true);
    const { oldest, newest } = await twoAbandonedFlows(jar);
    const newestValues = newest.names.map((name) => [name, jar.contents.get(name)] as const);
    const third = await start(jar);
    expect(deletionNames(third.response).sort()).toEqual([...oldest.names].sort());
    expect(oldest.names.every((name) => !jar.contents.has(name))).toBe(true);
    expect(newestValues.every(([name, content]) => jar.contents.get(name) === content)).toBe(true);
    expect(third.names.every((name) => jar.contents.has(name))).toBe(true);
    expect(rpc.intent).toHaveBeenCalledTimes(3);
    expectSessionUnchanged(jar, session);
  });

  it('keeps retiring so repeated abandoned sign-ins never lock the browser out', async () => {
    const jar = new CookieJar();
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect((await start(jar)).response.status).toBe(302);
      vi.setSystemTime(Date.now() + 2000);
    }
    expect([...jar.contents.keys()].filter((name) => name.startsWith(`${base.cookies!.state!.name}.`)).length).toBe(2);
  });

  it('picks the oldest by sealed issue time, not by cookie order', async () => {
    const jar = new CookieJar();
    const { oldest } = await twoAbandonedFlows(jar);
    const reordered = new CookieJar();
    for (const [name, content] of [...jar.contents].reverse()) reordered.contents.set(name, content);
    const third = await start(reordered);
    expect(deletionNames(third.response).sort()).toEqual([...oldest.names].sort());
  });

  it('refuses without clearing anything when forged state cookies cannot make room', async () => {
    const jar = new CookieJar();
    jar.contents.set(stateCookieName(randomBytes(16).toString('hex')), 'forged-state-value');
    jar.contents.set(stateCookieName(randomBytes(16).toString('hex')), 'forged-state-value');
    const response = await signIn(jar);
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('Location') ?? '').searchParams.get('error')).toBe('AuthBackendUnavailable');
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(rpc.intent).not.toHaveBeenCalled();
  });

  it('lets a sealed flow make room but never retires a forged cookie', async () => {
    const jar = new CookieJar();
    const authentic = await start(jar);
    const forged = stateCookieName(randomBytes(16).toString('hex'));
    jar.contents.set(forged, 'forged-state-value');
    const third = await start(jar);
    expect(deletionNames(third.response).sort()).toEqual([...authentic.names].sort());
    expect(jar.contents.get(forged)).toBe('forged-state-value');
  });

  it('keeps both pending flows when the new sign-in is not recorded', async () => {
    const jar = new CookieJar();
    const { oldest, newest } = await twoAbandonedFlows(jar);
    rpc.intent.mockRejectedValueOnce(new Error(privateErrorMarker));
    const response = await signIn(jar);
    expect(new URL(response.headers.get('Location') ?? '').searchParams.get('error')).toBe('AuthBackendUnavailable');
    expect(deletionNames(response)).toEqual([]);
    expect([...oldest.names, ...newest.names].every((name) => jar.contents.has(name))).toBe(true);
  });

  it('keeps both pending flows when the handler refuses before generating state', async () => {
    const jar = new CookieJar();
    await twoAbandonedFlows(jar);
    const csrfRejected: Invocation = async () =>
      new Response(null, { status: 302, headers: { Location: `${origin}/api/auth/signin?csrf=true` } });
    const response = await signIn(jar, clientAddress, csrfRejected);
    expect(response.status).toBe(302);
    expect(deletionNames(response)).toEqual([]);
    expect(rpc.intent).toHaveBeenCalledTimes(2);
  });
});

describe('per-client OAuth start limit', () => {
  it('stops one client before intent while another client keeps starting flows', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) await start(new CookieJar());
    expect(rpc.intent).toHaveBeenCalledTimes(20);

    // A forged first hop cannot buy a fresh bucket: the ingress appends the real one last.
    const limited = await signIn(new CookieJar(), `203.0.113.77, ${clientAddress}`);
    expect(limited.status).toBe(303);
    expect(new URL(limited.headers.get('Location') ?? '').searchParams.get('error')).toBe('AuthBackendUnavailable');
    expect(limited.headers.getSetCookie()).toEqual([]);
    expect(rpc.intent).toHaveBeenCalledTimes(20);

    expect((await start(new CookieJar(), '198.51.100.250')).response.status).toBe(302);
    expect(rpc.intent).toHaveBeenCalledTimes(21);
  });

  it('applies no limit in legacy mode', async () => {
    vi.stubEnv('CURRENT_STORE_WEB_OAUTH_MODE', 'legacy');
    const legacyHandler = vi.fn<Invocation>(
      async () => new Response(null, { status: 302, headers: { Location: 'https://provider.example.test/authorize' } }),
    );
    for (let attempt = 0; attempt < 25; attempt += 1)
      expect((await signIn(new CookieJar(), clientAddress, legacyHandler)).status).toBe(302);
    expect(legacyHandler).toHaveBeenCalledTimes(25);
    expect(rpc.intent).not.toHaveBeenCalled();
  });
});

describe('on the standalone server, whose request URL is its bind address', () => {
  it('sends the unavailable redirect to the configured site', async () => {
    rpc.intent.mockRejectedValueOnce(new Error(privateErrorMarker));
    const response = await signIn(new CookieJar(), clientAddress, invoke, 'https://0.0.0.0:3000');
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(`${origin}/auth/error?error=AuthBackendUnavailable`);
  });
});

describe('terminal identity denials', () => {
  const binding = { provider: 'google' as const, flow: 'a'.repeat(64), actorCookie: null };
  const signInParameters = {
    user: { id: 'provider-profile-id', name: 'Owned climber', email: 'owned@example.test' },
    account: { provider: 'google', type: 'oauth' as const, providerAccountId: 'owned-provider-subject' },
    profile: { sub: 'owned-provider-subject', email: 'owned@example.test' },
  };

  it.each([
    ['email_conflict', '/auth/error?error=OAuthAccountNotLinked'],
    ['email_required', '/auth/error?error=OAuthEmailRequired'],
    ['identity_unavailable', false],
    ['replayed', false],
  ] as const)('answers the %s denial with %s', async (code, expected) => {
    const delegated = createWebOAuthIdentityAuthRequest(base, binding, () => ({
      intent: vi.fn(),
      resolve: vi.fn().mockResolvedValue({
        webOAuthProtocolVersion: 1,
        operation: 'resolve',
        requestId: randomUUID(),
        outcome: 'denied',
        code,
      }),
    }));
    expect(await delegated.options.callbacks?.signIn?.(signInParameters)).toBe(expected);
    expect(delegated.resolved()).toBe(false);
    expect(delegated.unavailable()).toBe(false);
  });
});

describe('validated OAuth flow retirement at the request wrapper', () => {
  it('retires three failed verified flows so a later initiation still fits the budget, retaining a chunked current login', async () => {
    const jar = new CookieJar();
    const session = await seedCurrentSession(jar, true);
    terminal = 'unavailable';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const flow = await start(jar);
      const response = await callback(jar, flow);
      expect(new URL(response.headers.get('Location') ?? '', origin).searchParams.get('error')).toBe(
        'AuthBackendUnavailable',
      );
      expect(deletionNames(response).sort()).toEqual([...flow.names].sort());
      expect(flow.names.every((name) => !jar.contents.has(name))).toBe(true);
      expectSessionUnchanged(jar, session);
    }
    expect(rpc.intent).toHaveBeenCalledTimes(3);
    expect(rpc.resolve).toHaveBeenCalledTimes(3);
    expect(callbackInvocations).toBe(3);
    expect((await start(jar)).response.status).toBe(302);
  });

  it('caps new callback-URL cookies at fifteen minutes and retires them after completed responses', async () => {
    const jar = new CookieJar();
    for (let completed = 0; completed < 3; completed += 1) {
      const flow = await start(jar);
      expect(callbackUrlMaxAge).toBe(900);
      const callbackCookie = flow.response.headers
        .getSetCookie()
        .find((header) => header.startsWith(`${base.cookies!.callbackUrl!.name}.`));
      expect(callbackCookie?.includes('Max-Age=900')).toBe(true);
      const response = await callback(jar, flow);
      expect(response.status).toBe(302);
      expect(flow.names.every((name) => !jar.contents.has(name))).toBe(true);
      expect(deletionNames(response).sort()).toEqual([...flow.names].sort());
    }
    expect(base.cookies!.callbackUrl!.options.maxAge).toBe(30 * 86400);
    expect(rpc.resolve).not.toHaveBeenCalled();
  });

  it('cannot let a terminal A callback clear pending B or a newer current session', async () => {
    const jar = new CookieJar();
    const first = await start(jar);
    const second = await start(jar);
    const secondValues = second.names.map((name) => [name, jar.contents.get(name)] as const);
    const session = await seedCurrentSession(jar);
    terminal = 'unavailable';
    const response = await callback(jar, first);
    expect(deletionNames(response).sort()).toEqual([...first.names].sort());
    expect(secondValues.every(([name, content]) => jar.contents.get(name) === content)).toBe(true);
    expectSessionUnchanged(jar, session);
    terminal = 'completed';
    await callback(jar, second);
    expect(second.names.every((name) => !jar.contents.has(name))).toBe(true);
    expect((await start(jar)).response.status).toBe(302);
  });

  it('clears only observed exact flow names with the original domain/path while retaining unknown suffixes', async () => {
    const jar = new CookieJar();
    const flow = await start(jar);
    const nonceName = `${base.cookies!.nonce!.name}.${flow.scope}`;
    jar.contents.delete(nonceName);
    const unknown = `${base.cookies!.pkceCodeVerifier!.name}.${flow.scope}.foreign`;
    jar.contents.set(unknown, 'unrelated-owned-value');
    terminal = 'throw';
    const response = await callback(jar, flow);
    expect(deletionNames(response).sort()).toEqual(flow.names.filter((name) => name !== nonceName).sort());
    const clears = response.headers.getSetCookie().filter((header) => /Max-Age=0/i.test(header));
    expect(
      clears.every(
        (header) => /Path=\//i.test(header) && /Domain=\.example\.test/i.test(header) && /Secure/i.test(header),
      ),
    ).toBe(true);
    expect(jar.contents.get(unknown)).toBe('unrelated-owned-value');
    expect(rpc.resolve).not.toHaveBeenCalled();
  });

  it.each(['missing', 'ciphertext', 'duplicate', 'malformed-scope', 'wrong-state'])(
    'does not invoke auth or clear cookies before authenticating %s scope evidence',
    async (fault) => {
      const jar = new CookieJar();
      const flow = await start(jar);
      const stateName = `${base.cookies!.state!.name}.${flow.scope}`;
      const original = jar.contents.get(stateName);
      if (!original) throw new Error('Missing owned signed state');
      let cookie = jar.header();
      if (fault === 'missing')
        cookie = cookie
          .split('; ')
          .filter((pair) => !pair.startsWith(`${stateName}=`))
          .join('; ');
      if (fault === 'ciphertext') cookie = cookie.replace(original, 'invalid-owned-state-jwe');
      if (fault === 'duplicate') cookie += `; ${stateName}=${original}`;
      if (fault === 'malformed-scope') cookie = cookie.replace(stateName, `${base.cookies!.state!.name}.invalid`);
      const response = await callback(jar, flow, cookie, fault === 'wrong-state' ? 'another-owned-state' : flow.state);
      expect(response.headers.getSetCookie().length).toBe(0);
      expect(callbackInvocations).toBe(0);
      expect(rpc.resolve).not.toHaveBeenCalled();
      expect(flow.names.every((name) => jar.contents.has(name))).toBe(true);
    },
  );
});
