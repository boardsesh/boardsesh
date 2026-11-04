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

let environment: Awaited<ReturnType<typeof createPrototypeEnvironment>>;
let authority: PrototypeAuthority;
let server: Server;
let certificateDirectory: string;
let origin: string;

const fixtureHtml = `<!doctype html><html lang="en"><title>Disposable auth fixture</title><body>
<form id="login"><label>Email <input name="email" type="email" required></label>
<label>Password <input name="password" type="password" required></label><button>Sign in</button></form>
<p id="result" role="status"></p><script>
document.querySelector('#login').addEventListener('submit',async event=>{
event.preventDefault();const form=new FormData(event.target);
const response=await fetch('/api/auth/sign-in/email',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({email:form.get('email'),password:form.get('password')})});
document.querySelector('#result').textContent=response.ok?'Signed in':'Sign-in rejected';});
</script></body></html>`;

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
        outgoing.end(fixtureHtml);
        return;
      }
      // Model a proxy that explicitly forwards root RFC 8414 metadata as well
      // as the auth catch-all. Every response traverses a real HTTPS socket.
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, header] of Object.entries(incoming.headers)) {
        if (typeof header === 'string') headers.set(name, header);
        else if (header) for (const member of header) headers.append(name, member);
      }
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
  authority = environment.createAuthority({
    baseURL: `${origin}/api/auth`,
    trustedOrigins: [origin],
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
  const siblingOrigin = origin.replace('auth.boardsesh.test', 'www.boardsesh.test');
  await page.goto(siblingOrigin);
  const siblingSession = await page.evaluate(async () => (await fetch('/api/auth/get-session')).json());
  expect(siblingSession.user.id).toBe(registration.user.id);
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

test('the HTTPS proxy routes both standards-derived discovery paths with an exact issuer', async ({ page }) => {
  for (const path of [
    '/.well-known/oauth-authorization-server/api/auth',
    '/api/auth/.well-known/openid-configuration',
  ]) {
    const response = await page.goto(`${origin}${path}`);
    expect(response?.status()).toBe(200);
    const metadata = await response!.json();
    expect(metadata.issuer).toBe(`${origin}/api/auth`);
    expect(metadata.token_endpoint).toBe(`${origin}/api/auth/oauth2/token`);
  }
});
