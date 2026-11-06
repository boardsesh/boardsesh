import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mock } from 'node:test';
import nodemailer from 'nodemailer';
import { installNativeMobileHostBindings, mobileSourceRoot } from './native-mobile-host-io';

type RecoveryResult = { success: boolean; status?: number | null; error?: string };
interface RecoveryClient {
  requestPasswordReset(email: string): Promise<RecoveryResult>;
  resetPassword(email: string, token: string, password: string, confirmation: string): Promise<RecoveryResult>;
}
interface NativeStore {
  storeTokens(jwt: string, refresh: string, expires: string): Promise<void>;
  getAuthToken(): Promise<string | null>;
  getRefreshToken(): Promise<string | null>;
  getTokenExpiresAt(): Promise<Date | null>;
  captureAuthCredentialGeneration(): number;
}
type PublicModule = { POST(request: unknown): Promise<Response> };
const deadline = setTimeout(() => process.exit(2), 25000);
let phase = 'input';
function send(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error('Owned IPC unavailable'));
    process.send(message, (error) => (error ? reject(new Error('Owned IPC failed')) : resolve()));
  });
}
async function finish(message: object, code = 0) {
  await send(message);
  clearTimeout(deadline);
  process.exit(code);
}
function localOrigin(input: unknown): URL {
  if (typeof input !== 'string') throw new Error('Missing owned origin');
  const url = new URL(input);
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Only exact owned loopback origins allowed');
  return url;
}

async function webHost(input: Record<string, unknown>) {
  phase = 'web-config';
  const backend = localOrigin(input.origin);
  if (typeof input.secret !== 'string') throw new Error('Missing private fixture credential');
  Object.assign(process.env, {
    NODE_ENV: 'test',
    CURRENT_STORE_WEB_AUTH_MODE: 'backend-staging',
    CURRENT_STORE_AUTH_BACKEND_ORIGIN: backend.origin,
    CURRENT_STORE_AUTH_RPC_SECRET: input.secret,
    DATABASE_URL: 'postgresql://owned_probe:unused@127.0.0.1:1/owned_probe',
    READ_REPLICA_URL: 'postgresql://owned_probe:unused@127.0.0.1:1/owned_probe',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1',
    SMTP_USER: 'owned-probe@example.test',
    SMTP_PASSWORD: 'synthetic-offline-only',
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (address, options) => {
    const target = new URL(typeof address === 'string' || address instanceof URL ? address : address.url);
    if (
      target.origin !== backend.origin ||
      !['/api/internal/auth/current-store/forgot-password', '/api/internal/auth/current-store/reset-password'].includes(
        target.pathname,
      ) ||
      target.search ||
      target.hash ||
      target.username ||
      target.password
    )
      throw new Error('Unowned web fixture fetch refused');
    return realFetch(address, { ...options, redirect: 'error' });
  };
  const offline = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  let renderedText = '';
  let renderedHtml = '';
  let transportSelected = false;
  offline.use('compile', (mail, done) => {
    renderedText = typeof mail.data.text === 'string' ? mail.data.text : '';
    renderedHtml = typeof mail.data.html === 'string' ? mail.data.html : '';
    done();
  });
  mock.method(nodemailer, 'createTransport', () => {
    transportSelected = true;
    return offline;
  });
  // Nodemailer exposes distinct public ESM/CJS entrypoints. The web tsx graph
  // can use require while this child uses import; replace only SMTP I/O in both.
  const requireEmail = createRequire(new URL('../../../../../../shared/email/package.json', import.meta.url));
  const commonJsMailer = requireEmail('nodemailer') as typeof nodemailer;
  if (commonJsMailer !== nodemailer)
    mock.method(commonJsMailer, 'createTransport', () => {
      transportSelected = true;
      return offline;
    });
  phase = 'web-load';
  const requireWeb = createRequire(new URL('../../../../../../web/package.json', import.meta.url));
  const next = requireWeb('next/server') as {
    NextRequest: new (
      url: string,
      options: { method: string; headers: Record<string, string>; body: string },
    ) => unknown;
  };
  const forgot = (await import(
    new URL('../../../../../../web/app/api/auth/forgot-password/route.ts', import.meta.url).href
  )) as PublicModule;
  const reset = (await import(
    new URL('../../../../../../web/app/api/auth/reset-password/route.ts', import.meta.url).href
  )) as PublicModule;
  const active = new Set<Promise<void>>();
  const sockets = new Set<import('node:net').Socket>();
  let accepting = true;
  let origin = '';
  const server = createServer((request, response) => {
    if (!accepting) {
      response.destroy();
      return;
    }
    const pending = (async () => {
      if (
        request.method !== 'POST' ||
        !['/api/auth/forgot-password', '/api/auth/reset-password'].includes(request.url ?? '')
      ) {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > 16384) throw new Error('Owned public body cap');
        chunks.push(buffer);
      }
      const publicRequest = new next.NextRequest(`${origin}${request.url}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: request.headers.cookie ?? '',
          'X-Forwarded-For': '127.0.0.1',
        },
        body: Buffer.concat(chunks).toString('utf8'),
      });
      renderedText = '';
      renderedHtml = '';
      const result = await (request.url === '/api/auth/forgot-password' ? forgot : reset).POST(publicRequest);
      if (request.url === '/api/auth/forgot-password')
        await send({
          kind: 'mail-phase',
          transportSelected,
          compiledText: renderedText.length > 0,
          compiledHtml: renderedHtml.length > 0,
        });
      const link = renderedText.match(/https?:\/\/[^\s]+/)?.[0];
      if (link) {
        const url = new URL(link);
        const htmlLink = renderedHtml.match(/href="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
        await send({
          kind: 'mail',
          token: url.searchParams.get('token'),
          email: url.searchParams.get('email'),
          roundTrip:
            htmlLink === link &&
            renderedText.includes('expires in 1 hour') &&
            renderedHtml.includes('expires in 1 hour') &&
            url.origin === origin,
        });
      }
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    })().catch(() => {
      if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end('{"error":"AuthBackendUnavailable"}');
    });
    active.add(pending);
    void pending.finally(() => active.delete(pending));
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  phase = 'web-listen';
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Owned public bind failed');
  origin = `http://127.0.0.1:${address.port}`;
  process.env.BASE_URL = origin;
  process.env.NEXTAUTH_URL = origin;
  process.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const control = message as Record<string, unknown>;
    if (control.action === 'unavailable') {
      process.env.CURRENT_STORE_AUTH_RPC_SECRET = 'wrong-owned-credential-at-least-32bytes';
      void send({ kind: 'unavailable' });
    } else if (control.action === 'stop') {
      accepting = false;
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      void (async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.allSettled(active);
        offline.close();
        // The deny/allow guard remains installed until this child exits.
        await finish({ kind: 'stopped', quiescent: active.size === 0 });
      })();
    }
  });
  await send({ kind: 'ready', origin });
}

async function consumer(input: Record<string, unknown>) {
  phase = 'consumer-config';
  const origin = localOrigin(input.origin);
  if (
    (input.role !== 'native' && input.role !== 'expo') ||
    (input.operation !== 'forgot' && input.operation !== 'reset') ||
    typeof input.email !== 'string'
  )
    throw new Error('Invalid owned consumer');
  Object.assign(process.env, {
    NODE_ENV: 'test',
    EXPO_OS: 'ios',
    EXPO_PUBLIC_WEB_URL: origin.origin,
    EXPO_PUBLIC_BACKEND_URL: origin.origin,
    EXPO_PUBLIC_POSTHOG_KEY: '',
    EXPO_PUBLIC_SENTRY_DSN: '',
    EXPO_PUBLIC_SCREENSHOT_MODE: '1',
  });
  for (const key of Object.keys(process.env))
    if (/^(?:CURRENT_STORE_|NEXTAUTH_SECRET$|AUTH_SECRET$|CRON_SECRET$)/.test(key)) delete process.env[key];
  Object.assign(globalThis, { __DEV__: false });
  const host = installNativeMobileHostBindings();
  const realFetch = globalThis.fetch;
  let observedStatus: number | null = null;
  let noCookies = true;
  let noAuthority = true;
  let publicShape = true;
  let requests = 0;
  let outside = 0;
  const observations: Promise<void>[] = [];
  const expectedPath = input.operation === 'forgot' ? '/api/auth/forgot-password' : '/api/auth/reset-password';
  globalThis.fetch = async (address, options) => {
    const target = new URL(typeof address === 'string' || address instanceof URL ? address : address.url);
    if (
      target.origin !== origin.origin ||
      target.pathname !== expectedPath ||
      target.search ||
      target.hash ||
      target.username ||
      target.password
    ) {
      outside += 1;
      throw new Error('Unowned consumer fetch refused');
    }
    requests += 1;
    if (typeof options?.body !== 'string') throw new Error('Expected installed public body');
    const payload = JSON.parse(options.body) as Record<string, unknown>;
    const expectedKeys = input.operation === 'forgot' ? 'email' : 'confirmPassword,email,password,token';
    noAuthority &&=
      Object.keys(payload).sort().join(',') === expectedKeys && !new Headers(options.headers).has('authorization');
    const response = await realFetch(address, {
      ...options,
      redirect: 'error',
      headers: {
        ...Object.fromEntries(new Headers(options.headers)),
        Cookie: 'next-auth.session-token=owned-existing-cookie',
      },
    });
    observedStatus = response.status;
    noCookies &&= !response.headers.has('set-cookie');
    observations.push(
      response
        .clone()
        .json()
        .then((body: unknown) => {
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            publicShape = false;
            return;
          }
          const record = body as Record<string, unknown>;
          const key = response.ok ? 'message' : 'error';
          publicShape &&= Object.keys(record).join(',') === key && typeof record[key] === 'string';
        })
        .catch(() => {
          publicShape = false;
        }),
    );
    return response;
  };
  const storePath = input.role === 'native' ? 'src/lib/auth-store.ts' : 'src/lib/auth-store.web.ts';
  phase = 'consumer-load';
  const store = (await import(new URL(storePath, mobileSourceRoot).href)) as NativeStore;
  const auth = (await import(
    new URL(input.role === 'native' ? 'src/lib/auth.ts' : 'src/lib/auth.web.ts', mobileSourceRoot).href
  )) as RecoveryClient;
  const oldJwt = randomBytes(32).toString('base64url');
  const oldRefresh = randomBytes(32).toString('base64url');
  const oldExpiry = new Date(Date.now() + 86400000).toISOString();
  if (input.role === 'native') {
    await store.storeTokens(oldJwt, oldRefresh, oldExpiry);
    await Promise.all([store.getAuthToken(), store.getRefreshToken(), store.getTokenExpiresAt()]);
  }
  const generation = store.captureAuthCredentialGeneration();
  const before = new Map(host.secureValues);
  host.secureWrites.length = 0;
  phase = 'consumer-request';
  const result =
    input.operation === 'forgot'
      ? await auth.requestPasswordReset(input.email)
      : await auth.resetPassword(
          input.email,
          typeof input.token === 'string' ? input.token : '',
          'new-consumer-password',
          'new-consumer-password',
        );
  await Promise.allSettled(observations);
  let oldPreserved = true;
  if (input.role === 'native')
    oldPreserved =
      (await store.getAuthToken()) === oldJwt &&
      (await store.getRefreshToken()) === oldRefresh &&
      (await store.getTokenExpiresAt())?.toISOString() === oldExpiry &&
      host.secureValues.size === before.size &&
      [...before].every(([key, value]) => host.secureValues.get(key) === value);
  await finish({
    kind: 'result',
    ok: true,
    success: result.success,
    status: result.status ?? observedStatus,
    network: result.error === 'network',
    noCookies,
    noAuthority,
    publicShape,
    exactlyOne: requests === 1,
    noOutside: outside === 0 && host.unexpectedHostCalls === 0,
    oldPreserved,
    noWrites: host.secureWrites.length === 0,
    sameGeneration: store.captureAuthCredentialGeneration() === generation,
  });
}

process.once('message', (message: unknown) => {
  void (async () => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid owned input');
    const input = message as Record<string, unknown>;
    if (input.role === 'web') await webHost(input);
    else await consumer(input);
  })().catch((error: unknown) => {
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^ERR_[A-Z_]+$/.test(error.code)
        ? error.code
        : 'fixture_failure';
    void finish({ kind: 'failure', ok: false, phase, code }, 1);
  });
});
