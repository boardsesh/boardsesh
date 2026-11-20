import './legacy-credential-fixture';
// @vitest-environment node
/**
 * #7596 B5e1: www's unlink and reauthentication routes under
 * `AUTH_BROWSER_SESSION_MODE=better-auth`. Reauthentication by password and by
 * a fresh Google sign-in (`max_age=0`, `prompt=select_account consent`,
 * #7590), a five-minute-old Google sign-in refused, the last sign-in method
 * kept, and Apple answered `reauthentication_unavailable`. Real routes, the
 * real backend handlers over HTTP, real PostgreSQL, the Google stand-in.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createEnvironment } from '../../backend/src/auth/authority/__tests__/environment';
import { readFirstPartySession } from '../../backend/src/auth/authority/session-reader';
import { CookieJar, patchNextRequestIo } from './route-harness';
import {
  PASSWORD,
  browserSteps,
  canonicalStatus,
  createClimber,
  loginToken,
  startWebSessionBackend,
  stubBetterAuthEnvironment,
  type WebSessionBackend,
} from './web-session-harness';
import { GOOGLE_CERTS_URL, startGoogleOidcFixture, type GoogleIdentity } from './google-oidc-fixture';
import { FLOW_COOKIE, addProviderSecurityTables, providerSecuritySteps } from './provider-security-steps';

const holder = vi.hoisted(() => {
  process.env.NEXTAUTH_SECRET = 'provider-security-unlink-proof-nextauth-secret-7596';
  process.env.NEXTAUTH_URL = 'https://www.boardsesh.com';
  process.env.GOOGLE_CLIENT_ID = 'provider-security-unlink-proof.apps.googleusercontent.test';
  process.env.GOOGLE_CLIENT_SECRET = 'provider-security-unlink-proof-google-secret';
  return { database: undefined as unknown };
});
vi.mock('server-only', () => ({}));
vi.mock('@/app/lib/db/db', () => ({ getDb: () => holder.database }));
vi.mock('../../backend/src/db/client', () => ({
  get db() {
    return holder.database;
  },
}));
vi.mock('../../backend/src/auth/admission-pool', () => ({
  readOnAdmissionConnection: async (mark: () => void, read: (database: unknown) => PromiseLike<unknown>) => {
    mark();
    return read(holder.database);
  },
}));
vi.mock('../app/lib/auth/credential-admission.server', async (original) => ({
  ...(await original<typeof import('../app/lib/auth/credential-admission.server')>()),
  admitPresentedWebCredential: async (credential: string) => {
    const result = await readFirstPartySession(environment.database, { kind: 'legacy-jwe', credential, secret });
    if (result.status === 'unavailable') throw new Error('Owned authority unavailable');
    return result.status === 'admitted' ? result.session.userId : null;
  },
}));
// The test seam: the preconditions alone, as once the www cutover list is empty.
vi.mock('../app/lib/auth/browser-session-mode.server', async (original) => {
  const actual = await original<typeof import('../app/lib/auth/browser-session-mode.server')>();
  return { ...actual, browserSessionRouteMode: actual.browserSessionRouteModeResolver([]) };
});

import * as authRoute from '../app/api/auth/[...nextauth]/route';
import * as providerSecurityRoute from '../app/api/auth/provider-security/[...step]/route';
import { authOptions } from '../app/lib/auth/auth-options';

const secret = 'provider-security-unlink-proof-nextauth-secret-7596';
const { csrf, login } = browserSteps(authRoute);
let environment: Awaited<ReturnType<typeof createEnvironment>>;
let backend: WebSessionBackend;
let google: Awaited<ReturnType<typeof startGoogleOidcFixture>>;
let steps: ReturnType<typeof providerSecuritySteps>;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  environment = await createEnvironment();
  await addProviderSecurityTables(environment.client);
  holder.database = environment.database;
  backend = await startWebSessionBackend(environment.database);
  google = await startGoogleOidcFixture(process.env.GOOGLE_CLIENT_ID ?? '');
  patchNextRequestIo();
  const provider = authOptions.providers.find((configured) => configured.id === 'google');
  if (!provider || provider.type !== 'oauth' || !provider.options) throw new Error('No Google provider configured');
  Object.assign(provider.options, { wellKnown: google.discoveryUrl });
  steps = providerSecuritySteps(providerSecurityRoute, authRoute, google);
});
beforeEach(() => {
  stubBetterAuthEnvironment(backend.origin);
  vi.stubEnv('AUTH_BROWSER_ACCESS_TOKEN_SECRET', 'provider-security-unlink-proof-access-secret-7596-b5e1');
  vi.stubEnv('CURRENT_STORE_PROVIDER_GOOGLE_AUTH_TIME_MODE', 'auth-time-staging');
  vi.stubEnv('CURRENT_STORE_PROVIDER_SECURITY_MODE', 'backend-staging');
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === GOOGLE_CERTS_URL) return Response.json(google.certificates());
    return realFetch(input, init);
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(console.warn).mockRestore();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await google?.close();
  await backend?.close();
  await environment?.close();
});

const identityAt = (subject: string, authAgoSeconds: number): GoogleIdentity => ({
  subject,
  email: `${subject}@example.test`,
  authTimeSeconds: Math.floor(Date.now() / 1000) - authAgoSeconds,
});

/** A password climber with a Google identity linked through the routes. */
async function climberWithGoogle() {
  const climber = await createClimber(environment.database);
  const jar = new CookieJar();
  await login(jar, climber.email);
  const subject = `google-${randomUUID()}`;
  expect(await steps.linkGoogleWithPassword(jar, identityAt(subject, 30), PASSWORD)).toBe('linked');
  return { climber, jar, subject };
}

async function startUnlinkOfGoogle(jar: CookieJar) {
  const methods = await steps.methodsOf(jar);
  const google = methods.providers.find((method) => method.provider === 'google');
  if (!google) throw new Error('No Google method to unlink');
  const started = await steps.post('start', jar, { action: 'unlink', provider: 'google', methodId: google.methodId });
  expect(started.status).toBe(200);
}

/** Starts the Google reauthentication of the open flow and follows Google back to www. */
async function reauthenticateWithGoogle(jar: CookieJar, identity: GoogleIdentity) {
  const started = await steps.post('reauthenticate/google', jar);
  expect(started.status).toBe(200);
  const { url } = (await started.json()) as { url: string };
  const authorization = new URL(url);
  expect(authorization.searchParams.get('max_age')).toBe('0');
  expect(authorization.searchParams.get('prompt')).toBe('select_account consent');
  expect(authorization.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const { response } = await steps.followGoogle(jar, url, identity);
  return steps.resultOf(response);
}

const googleLinked = async (jar: CookieJar) =>
  (await steps.methodsOf(jar)).providers.some((method) => method.provider === 'google');

describe('provider unlink and reauthentication under better-auth', () => {
  it('unlinks after a password reauthentication: committed JSON, same token, other session ended', async () => {
    const { climber, jar } = await climberWithGoogle();
    const second = new CookieJar();
    await login(second, climber.email);
    const token = loginToken(jar);
    await startUnlinkOfGoogle(jar);
    const committed = await steps.post('reauthenticate/password', jar, { password: PASSWORD });
    expect(committed.status).toBe(200);
    expect(await committed.json()).toMatchObject({ status: 'committed', action: 'unlink', refreshAccessToken: true });
    expect(jar.get(FLOW_COOKIE)).toBeUndefined();
    expect(loginToken(jar)).toBe(token);
    expect(await canonicalStatus(environment.database, token)).toBe('admitted');
    expect(await canonicalStatus(environment.database, loginToken(second))).not.toBe('admitted');
    expect(await googleLinked(jar)).toBe(false);
  });

  it('unlinks after a fresh Google reauthentication of the linked identity', async () => {
    const { jar, subject } = await climberWithGoogle();
    await startUnlinkOfGoogle(jar);
    expect(await reauthenticateWithGoogle(jar, identityAt(subject, 20))).toBe('unlinked');
    expect(await googleLinked(jar)).toBe(false);
  });

  it('refuses a Google sign-in that is five minutes old: nothing changes', async () => {
    const { jar, subject } = await climberWithGoogle();
    const token = loginToken(jar);
    await startUnlinkOfGoogle(jar);
    expect(await reauthenticateWithGoogle(jar, identityAt(subject, 5 * 60 + 30))).toBe('reauthentication_required');
    expect(await googleLinked(jar)).toBe(true);
    expect(await canonicalStatus(environment.database, token)).toBe('admitted');
  });

  it("refuses to remove a Google-only account's last sign-in method", async () => {
    const subject = `google-${randomUUID()}`;
    const jar = new CookieJar();
    const signedIn = await steps.googleSignIn(jar, identityAt(subject, 20), await csrf(jar));
    expect(signedIn.response.status).toBeLessThan(400);
    const methods = await steps.methodsOf(jar);
    expect(methods.passwordUsable).toBe(false);
    expect(methods.providers.find((method) => method.provider === 'google')?.canUnlink).toBe(false);
    await startUnlinkOfGoogle(jar);
    expect(await reauthenticateWithGoogle(jar, identityAt(subject, 20))).toBe('last_usable_method');
    expect(await googleLinked(jar)).toBe(true);
  });

  it('answers reauthentication_unavailable for Apple and keeps the flow', async () => {
    const { jar } = await climberWithGoogle();
    await startUnlinkOfGoogle(jar);
    const apple = await steps.post('reauthenticate/apple', jar);
    expect(apple.status).toBe(403);
    expect(await apple.json()).toMatchObject({ outcome: 'reauthentication_unavailable' });
    expect(jar.get(FLOW_COOKIE)).toBeDefined();
    const aborted = await steps.post('abort', jar);
    expect(await aborted.json()).toEqual({ status: 'aborted' });
    expect(jar.get(FLOW_COOKIE)).toBeUndefined();
  });

  it('a cancelled Google reauthentication keeps the flow, so the password still works', async () => {
    const { jar } = await climberWithGoogle();
    await startUnlinkOfGoogle(jar);
    const started = await steps.post('reauthenticate/google', jar);
    const { url } = (await started.json()) as { url: string };
    const state = new URL(url).searchParams.get('state') ?? '';
    const cancelled = await steps.call(
      'GET',
      `callback/google?${new URLSearchParams({ state, error: 'access_denied' })}`,
      jar,
    );
    jar.apply(cancelled);
    expect(steps.resultOf(cancelled)).toBe('cancelled');
    expect(jar.get(FLOW_COOKIE)).toBeDefined();
    const committed = await steps.post('reauthenticate/password', jar, { password: PASSWORD });
    expect(await committed.json()).toMatchObject({ status: 'committed', action: 'unlink' });
  });
});
