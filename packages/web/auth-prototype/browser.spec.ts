import { execFileSync } from 'node:child_process';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createPrototypeEnvironment } from '../../backend/src/auth/prototype/environment';
import type { PrototypeAuthority } from '../../backend/src/auth/prototype/authority';
import { PROTOTYPE_RESOURCE } from '../../backend/src/auth/prototype/oauth-options';
import { applyCorsHeaders, initCors } from '../../backend/src/handlers/cors';

let environment: Awaited<ReturnType<typeof createPrototypeEnvironment>>;
let authority: PrototypeAuthority;
let server: Server;
let certificateDirectory: string;
let origin: string;
let websiteOrigin: string;
let appOrigin: string;
const preflightOrigins: string[] = [];

function fixtureHtml(authOrigin: string) {
  return `<!doctype html><html lang="en"><title>Disposable auth fixture</title><body>
<form id="login"><label>Email <input name="email" type="email" required></label>
<label>Password <input name="password" type="password" required></label><button>Sign in</button></form>
<p id="result" role="status"></p><script>
document.querySelector('#login').addEventListener('submit',async event=>{
event.preventDefault();const form=new FormData(event.target);
const response=await fetch('${authOrigin}/api/auth/sign-in/email',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},
body:JSON.stringify({email:form.get('email'),password:form.get('password')})});
document.querySelector('#result').textContent=response.ok?'Signed in':'Sign-in rejected';});
</script></body></html>`;
}

test.beforeAll(async () => {
  environment = await createPrototypeEnvironment();
  certificateDirectory = await mkdtemp(join(tmpdir(), 'boardsesh-ba01-browser-'));
  const keyPath = join(certificateDirectory, 'key.pem');
  const certificatePath = join(certificateDirectory, 'certificate.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=*.boardsesh.test',
      '-addext',
      'subjectAltName=DNS:*.boardsesh.test',
      '-keyout',
      keyPath,
      '-out',
      certificatePath,
    ],
    { stdio: 'ignore' },
  );
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certificatePath)]);
  server = createServer({ key, cert }, async (incoming, outgoing) => {
    try {
      const requestUrl = new URL(incoming.url ?? '/', origin);
      if (requestUrl.pathname === '/' || requestUrl.pathname === '/callback') {
        outgoing.writeHead(200, { 'content-type': 'text/html' });
        outgoing.end(fixtureHtml(origin));
        return;
      }
      if (requestUrl.pathname === '/server-session') {
        if (![new URL(websiteOrigin).host, new URL(appOrigin).host].includes(incoming.headers.host ?? '')) {
          outgoing.writeHead(404);
          outgoing.end();
          return;
        }
        // The presentation server forwards HttpOnly cookies; browser JavaScript
        // never receives their values. Only the public user ID enters the HTML.
        const session = await authority.api.getSession({
          headers: new Headers({ cookie: incoming.headers.cookie ?? '' }),
        });
        outgoing.writeHead(200, { 'content-type': 'text/html' });
        outgoing.end(`<p role="status">${session ? `Signed in as ${session.user.id}` : 'Signed out'}</p>`);
        return;
      }
      if (incoming.method === 'OPTIONS' && incoming.headers.origin) preflightOrigins.push(incoming.headers.origin);
      // Exercise the existing backend CORS implementation, including browser
      // preflight. This fixture never exposes a permissive wildcard alternative.
      if (!applyCorsHeaders(incoming, outgoing)) return;
      // Model a proxy that explicitly forwards root RFC 8414 metadata as well
      // as the auth catch-all. Every response traverses a real HTTPS socket.
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, header] of Object.entries(incoming.headers)) {
        if (typeof header === 'string') headers.set(name, header);
        else if (header) for (const member of header) headers.append(name, member);
      }
      // Model a trusted TLS-terminating edge, replacing client-supplied
      // forwarding fields. This is a local adapter model, not deployed ingress.
      headers.set('x-forwarded-host', incoming.headers.host ?? '');
      headers.set('x-forwarded-proto', 'https');
      const response = await authority.handler(
        new Request(requestUrl, {
          method: incoming.method,
          headers,
          ...(['GET', 'HEAD'].includes(incoming.method ?? 'GET')
            ? {}
            : { body: Buffer.concat(chunks).toString('utf8') }),
        }),
      );
      for (const [name, header] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name, header);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader('set-cookie', cookies);
      outgoing.writeHead(response.status);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500);
      outgoing.end('Synthetic proxy request failed');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic HTTPS server has no local port');
  origin = `https://auth.boardsesh.test:${address.port}`;
  websiteOrigin = origin.replace('auth.boardsesh.test', 'www.boardsesh.test');
  appOrigin = origin.replace('auth.boardsesh.test', 'app.boardsesh.test');
  const previousAppOrigin = process.env.APP_ORIGIN;
  try {
    process.env.APP_ORIGIN = appOrigin;
    initCors(websiteOrigin);
  } finally {
    if (previousAppOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = previousAppOrigin;
  }
  authority = environment.createAuthority({
    baseURL: `${origin}/api/auth`,
    trustedOrigins: [origin, websiteOrigin, appOrigin],
    advanced: { crossSubDomainCookies: { enabled: true, domain: '.boardsesh.test' } },
  });
});

test.afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await environment?.close();
  if (certificateDirectory) await rm(certificateDirectory, { recursive: true, force: true });
});

test('real HTTPS browser keeps HttpOnly shared-domain cookies through OAuth redirects and sign-out', async ({
  page,
  context,
}) => {
  const email = `${randomUUID()}@example.test`;
  const registration = await authority.api.signUpEmail({
    body: { name: 'Browser fixture', email, password: 'synthetic-browser-password' },
  });
  await page.goto(origin);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('synthetic-browser-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('status')).toHaveText('Signed in');
  const cookies = await context.cookies();
  const sessionCookie = cookies.find((cookie) => cookie.name.endsWith('better-auth.session_token'));
  expect(sessionCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', domain: '.boardsesh.test' });
  expect(await page.evaluate(() => document.cookie)).not.toContain('session_token');
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const client = await authority.api.adminCreateOAuthClient({
    headers: new Headers({ cookie: cookieHeader }),
    body: {
      client_name: 'Browser fixture',
      redirect_uris: [`${origin}/callback`],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'profile:read offline_access',
      require_pkce: true,
      skip_consent: true,
    },
  });
  await environment.database.insert(environment.schema.oauthClientResource).values({
    id: randomUUID(),
    clientId: client.client_id,
    resourceId: PROTOTYPE_RESOURCE,
    createdAt: new Date(),
  });
  const verifier = randomBytes(32).toString('base64url');
  const state = randomUUID();
  const authorization = new URL(`${origin}/api/auth/oauth2/authorize`);
  authorization.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: `${origin}/callback`,
    response_type: 'code',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    scope: 'profile:read offline_access',
    resource: PROTOTYPE_RESOURCE,
    state,
  }).toString();
  await page.goto(authorization.toString());
  await expect(page).toHaveURL(new RegExp('/callback\\?'));
  const callback = new URL(page.url());
  expect(callback.searchParams.get('state')).toBe(state);
  expect(callback.searchParams.get('iss')).toBe(`${origin}/api/auth`);
  expect(callback.searchParams.get('code')).toBeTruthy();
  const browserSession = await page.evaluate(async () => (await fetch('/api/auth/get-session')).json());
  expect(browserSession.user.id).toBe(registration.user.id);
  // A sibling subdomain receives the same cookie on an actual browser request.
  await page.goto(`${websiteOrigin}/server-session`);
  await expect(page.getByRole('status')).toHaveText(`Signed in as ${registration.user.id}`);
  await page.goto(origin);
  expect(
    await page.evaluate(
      async () =>
        (
          await fetch('/api/auth/sign-out', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
    ),
  ).toBe(200);
  expect(await page.evaluate(async () => (await fetch('/api/auth/get-session')).json())).toBeNull();
  expect((await context.cookies()).some((cookie) => cookie.name.endsWith('better-auth.session_token'))).toBe(false);
});

test('www and Expo web complete credentialed CORS login, SSR, and logout across HTTPS origins', async ({
  page,
  context,
}) => {
  for (const presentationOrigin of [websiteOrigin, appOrigin]) {
    await context.clearCookies();
    const email = `${randomUUID()}@example.test`;
    const registration = await authority.api.signUpEmail({
      body: { name: 'Cross-origin fixture', email, password: 'synthetic-cross-origin-password' },
    });
    const previousPreflights = preflightOrigins.filter((candidate) => candidate === presentationOrigin).length;
    await page.goto(presentationOrigin);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill('synthetic-cross-origin-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('status')).toHaveText('Signed in');
    expect(preflightOrigins.filter((candidate) => candidate === presentationOrigin).length).toBeGreaterThan(
      previousPreflights,
    );
    expect(await page.evaluate(() => document.cookie)).not.toContain('session_token');
    const session = await page.evaluate(async (authOrigin) => {
      const response = await fetch(`${authOrigin}/api/auth/get-session`, { credentials: 'include' });
      return { status: response.status, body: await response.json() };
    }, origin);
    expect(session).toMatchObject({ status: 200, body: { user: { id: registration.user.id } } });
    await page.goto(`${presentationOrigin}/server-session`);
    await expect(page.getByRole('status')).toHaveText(`Signed in as ${registration.user.id}`);
    const logoutStatus = await page.evaluate(async (authOrigin) => {
      return (
        await fetch(`${authOrigin}/api/auth/sign-out`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status;
    }, origin);
    expect(logoutStatus).toBe(200);
    await page.reload();
    await expect(page.getByRole('status')).toHaveText('Signed out');
  }
});

test('untrusted sibling JavaScript cannot read auth responses or sign out another origin', async ({ page }) => {
  const registration = await authority.api.signUpEmail({
    body: { name: 'Origin-isolation fixture', email: `${randomUUID()}@example.test`, password: 'origin-password' },
  });
  await page.goto(origin);
  await page.getByLabel('Email', { exact: true }).fill(registration.user.email);
  await page.getByLabel('Password', { exact: true }).fill('origin-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('status')).toHaveText('Signed in');
  const untrustedOrigin = origin.replace('auth.boardsesh.test', 'untrusted.boardsesh.test');
  // Shared-domain cookies require trusting every server in that domain. This
  // case tests hostile JavaScript origins, not a compromised sibling server.
  await page.goto(untrustedOrigin);
  const blocked = await page.evaluate(async (authOrigin) => {
    const attempt = async (path: string, mutation: boolean) => {
      try {
        const response = await fetch(`${authOrigin}/api/auth/${path}`, {
          credentials: 'include',
          ...(mutation ? { method: 'POST', body: new URLSearchParams() } : {}),
        });
        return { readable: true, status: response.status };
      } catch {
        return { readable: false };
      }
    };
    return { read: await attempt('get-session', false), mutation: await attempt('sign-out', true) };
  }, origin);
  expect(blocked).toEqual({ read: { readable: false }, mutation: { readable: false } });
  await page.goto(`${websiteOrigin}/server-session`);
  await expect(page.getByRole('status')).toHaveText(`Signed in as ${registration.user.id}`);
});

test('the HTTPS proxy routes discovery and overwrites hostile forwarding headers', async ({ page }) => {
  for (const path of [
    '/.well-known/oauth-authorization-server/api/auth',
    '/api/auth/.well-known/openid-configuration',
  ]) {
    const response = await page.goto(`${origin}${path}`);
    expect(response?.status()).toBe(200);
    const metadata = await response!.json();
    expect(metadata.issuer).toBe(`${origin}/api/auth`);
    expect(metadata.token_endpoint).toBe(`${origin}/api/auth/oauth2/token`);
    // Use the browser's resolver, rather than Node DNS, for the local-only host.
    const forgedForwarding = await page.evaluate(async (metadataPath) => {
      const response = await fetch(metadataPath, {
        headers: { 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'http' },
      });
      return { status: response.status, body: await response.json() };
    }, path);
    expect(forgedForwarding).toMatchObject({ status: 200, body: { issuer: `${origin}/api/auth` } });
  }
});
