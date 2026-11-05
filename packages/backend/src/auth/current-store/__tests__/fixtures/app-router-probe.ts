import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import * as https from 'node:https';
import * as http from 'node:http';
import type { Socket } from 'node:net';
import {
  startConfiguredProviderTransport,
  type ConfiguredIdentity,
  type ConfiguredProviderFaults,
} from './app-router-providers';
import type { NextAuthOptions } from '../../../../../../web/node_modules/next-auth';
import type { JWT } from '../../../../../../web/node_modules/next-auth/jwt';
import type { NextRequest } from '../../../../../../web/node_modules/next/server';
import { ownedAppRouterDatabase } from './app-router-owned-db';
import { installAppRouterFixtureDelegate } from './app-router-delegate';

const webRequire = createRequire(new URL('../../../../../../web/package.json', import.meta.url));
const nextRequire = createRequire(webRequire.resolve('next-auth'));
const requestStorage = new AsyncLocalStorage<NextRequest>();
const active = new Set<Promise<void>>();
const sockets = new Set<Socket>();
let phase = 'input';
let accepting = true;
const deadline = setTimeout(() => process.exit(2), 120000);
const send = (message: object) =>
  new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(new Error('Owned IPC unavailable'));
    process.send(message, (error) => (error ? reject(new Error('Owned IPC failed')) : resolve()));
  });
const asRecord = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid owned input');
  return input as Record<string, unknown>;
};

async function start(input: Record<string, unknown>) {
  phase = 'provider';
  const providers = await startConfiguredProviderTransport();
  let route: {
    GET(request: NextRequest, context: object): Promise<Response>;
    POST(request: NextRequest, context: object): Promise<Response>;
  };
  let origin = '';
  let delegate: ReturnType<typeof installAppRouterFixtureDelegate> | undefined;
  let releaseEncode: (() => void) | undefined;
  const observations = {
    events: [] as string[],
    logs: [] as string[],
    signIns: [] as { provider: string; userId: string }[],
    transports: [] as { method: string; path: string; session: boolean; state: boolean; pkce: boolean }[],
    providerRedirects: [] as { official: boolean; cookiesPreserved: boolean; count: number }[],
    forwardedCookies: [] as { preserved: boolean; count: number }[],
  };
  const server = https.createServer(providers.tls, (request, response) => {
    if (!accepting) {
      response.destroy();
      return;
    }
    const pending = (async () => {
      if (!request.url?.startsWith('/api/auth/') && !request.url?.startsWith('/__proof/continue/')) {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request as AsyncIterable<Buffer>) {
        bytes += chunk.length;
        if (bytes > 32768) throw new Error('Owned App Router body limit');
        chunks.push(chunk);
      }
      const { NextRequest: RequestConstructor } = webRequire('next/server') as { NextRequest: typeof NextRequest };
      const headers = new Headers();
      for (const [name, content] of Object.entries(request.headers)) {
        if (typeof content === 'string') headers.set(name, content);
        else if (content) for (const member of content) headers.append(name, member);
      }
      headers.set('x-forwarded-host', new URL(origin).host);
      headers.set('x-forwarded-proto', 'https');
      let current = new RequestConstructor(new URL(request.url, origin), {
        method: request.method,
        headers,
        ...(['GET', 'HEAD'].includes(request.method ?? 'GET') ? {} : { body: Buffer.concat(chunks).toString('utf8') }),
      });
      observations.transports.push({
        method: request.method ?? 'GET',
        path: current.nextUrl.pathname,
        session: current.cookies
          .getAll()
          .some((cookie) => cookie.name.startsWith('__Secure-next-auth.session-token') && cookie.value.length > 0),
        state: current.cookies.getAll().some((cookie) => cookie.name.includes('state') && cookie.value.length > 0),
        pkce: current.cookies.getAll().some((cookie) => cookie.name.includes('pkce') && cookie.value.length > 0),
      });
      if (delegate) {
        const normalized = await delegate.normalize(current, RequestConstructor);
        if (normalized instanceof Response) {
          response.writeHead(normalized.status, Object.fromEntries(normalized.headers));
          response.end();
          return;
        }
        current = normalized;
      }
      const parameters = new URL(current.url).pathname
        .slice('/api/auth/'.length)
        .split('/')
        .map((segment) => decodeURIComponent(segment));
      const context = { params: Promise.resolve({ nextauth: parameters }) };
      const invoke = () => (current.method === 'POST' ? route.POST(current, context) : route.GET(current, context));
      const result = await requestStorage.run(current, () => (delegate ? delegate.run(current, invoke) : invoke()));
      if (input.browserIdentity && current.nextUrl.pathname === '/api/auth/signin/apple' && result.status === 302) {
        const originalCookies = result.headers.getSetCookie();
        const authorization = result.headers.get('Location');
        if (!authorization) throw new Error('Missing configured browser provider redirect');
        const callback = providers.authorize(
          authorization,
          asRecord(input.browserIdentity) as unknown as ConfiguredIdentity,
        );
        result.headers.set('Location', providers.browserPage(callback));
        observations.providerRedirects.push({
          official: new URL(authorization).origin === 'https://appleid.apple.com',
          cookiesPreserved: JSON.stringify(originalCookies) === JSON.stringify(result.headers.getSetCookie()),
          count: originalCookies.length,
        });
      }
      for (const [name, content] of result.headers) if (name !== 'set-cookie') response.setHeader(name, content);
      const cookies = result.headers.getSetCookie();
      if (cookies.length) response.setHeader('Set-Cookie', cookies);
      observations.forwardedCookies.push({
        preserved: JSON.stringify(cookies) === JSON.stringify(response.getHeader('set-cookie') ?? []),
        count: cookies.length,
      });
      response.writeHead(result.status);
      response.end(Buffer.from(await result.arrayBuffer()));
    })().catch(() => {
      if (!response.headersSent) response.writeHead(503, { 'Cache-Control': 'no-store' });
      response.end('Owned proof unavailable');
    });
    active.add(pending);
    void pending.finally(() => active.delete(pending));
  });
  server.requestTimeout = 8000;
  server.headersTimeout = 8000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Owned app bind failed');
  origin = `https://localhost:${address.port}`;
  providers.registerRedirect(origin);
  const database = ownedAppRouterDatabase(String(input.databaseUrl));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    NEXTAUTH_URL: origin,
    NEXTAUTH_SECRET: String(input.secret),
    BASE_URL: origin,
    AUTH_COOKIE_DOMAIN: '',
    VERCEL_ENV: '',
    VERCEL_URL: '',
    AUTH_TRUST_HOST: '1',
    DATABASE_URL: database.href,
    READ_REPLICA_URL: database.href,
    DEBUG_SQL: 'false',
    CURRENT_STORE_WEB_AUTH_MODE: 'legacy',
    GOOGLE_CLIENT_ID: providers.clients.google.id,
    GOOGLE_CLIENT_SECRET: providers.clients.google.secret,
    APPLE_ID: providers.clients.apple.id,
    APPLE_SECRET: providers.clients.apple.secret,
    FACEBOOK_CLIENT_ID: providers.clients.facebook.id,
    FACEBOOK_CLIENT_SECRET: providers.clients.facebook.secret,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1',
    SMTP_USER: 'owned@example.test',
    SMTP_PASSWORD: 'unused',
  });
  phase = 'transport';
  // Public HTTP customization only; do not import or patch NextAuth core.
  const oidc = nextRequire('openid-client') as { custom: { setHttpOptionsDefaults(options: object): void } };
  oidc.custom.setHttpOptionsDefaults({ agent: providers.agent, timeout: 3000 });
  const nativeHttps = webRequire('node:https') as typeof https;
  const nativeHttp = webRequire('node:http') as typeof http;
  const originalHttps = nativeHttps.request;
  mock.method(nativeHttps, 'request', (url: string | URL, options: https.RequestOptions) => {
    const parsed = new URL(url);
    if (!providers.allowedDestinations.has(`${parsed.origin}${parsed.pathname}`) || options.agent !== providers.agent)
      throw new Error('Unowned HTTPS request refused');
    return originalHttps(url, options);
  });
  mock.method(nativeHttp, 'request', () => {
    throw new Error('Unowned HTTP request refused');
  });
  const originalFetch = globalThis.fetch;
  const compound = input.compound ? asRecord(input.compound) : undefined;
  globalThis.fetch = async (address, settings) => {
    const destination = new URL(typeof address === 'string' || address instanceof URL ? address : address.url);
    if (
      !compound ||
      destination.origin !== compound.origin ||
      !['/intent', '/compound', '/abort', '/validate'].includes(destination.pathname) ||
      destination.search ||
      destination.hash ||
      destination.username ||
      destination.password
    )
      throw new Error('Unowned fetch refused');
    const response = await originalFetch(address, { ...settings, redirect: 'error' });
    if (
      destination.pathname === '/compound' &&
      input.faults &&
      ((response.status === 409 && asRecord(input.faults).discardConflictResponse === true) ||
        (response.status === 200 && asRecord(input.faults).discardSuccessfulCompoundResponse === true))
    ) {
      // Receive and discard a real response, making only this caller uncertain.
      // This is not a network failure before acknowledgement headers.
      await response.arrayBuffer();
      throw new Error('Owned compound response discarded');
    }
    return response;
  };
  const nextIo = webRequire('next/headers') as {
    headers(): Promise<Headers>;
    cookies(): Promise<{ getAll(): { name: string; value: string }[] }>;
  };
  mock.method(nextIo, 'headers', async () => requestStorage.getStore()?.headers ?? new Headers());
  mock.method(nextIo, 'cookies', async () => ({ getAll: () => requestStorage.getStore()?.cookies.getAll() ?? [] }));
  phase = 'route-load';
  const loaded = (await import(
    new URL('../../../../../../web/app/lib/auth/auth-options.ts', import.meta.url).href
  )) as { authOptions: NextAuthOptions };
  const options = loaded.authOptions;
  const originalSignIn = options.callbacks?.signIn;
  options.callbacks = {
    ...options.callbacks,
    async signIn(parameters) {
      observations.signIns.push({ provider: parameters.account?.provider ?? '', userId: parameters.user.id });
      return originalSignIn ? originalSignIn(parameters) : true;
    },
  };
  const createUser = options.events?.createUser;
  options.events = {
    ...options.events,
    async createUser(parameters) {
      observations.events.push('createUser');
      if (createUser) await createUser(parameters);
    },
    async linkAccount() {
      observations.events.push('linkAccount');
    },
    async signIn() {
      observations.events.push('signIn');
    },
  };
  options.logger = {
    error(code) {
      observations.logs.push(code);
    },
    warn() {},
    debug() {},
  };
  if (compound) {
    const publicJwt = webRequire('next-auth/jwt') as {
      encode: Parameters<typeof installAppRouterFixtureDelegate>[0]['encode'];
    };
    delegate = installAppRouterFixtureDelegate({
      authOptions: options,
      backend: { origin: String(compound.origin), secret: String(compound.secret) },
      fetch: globalThis.fetch,
      encode: publicJwt.encode,
      faults: input.faults ? asRecord(input.faults) : undefined,
      beforeEncode:
        input.faults && asRecord(input.faults).pauseBeforeEncode === true
          ? async () => {
              const pending = new Promise<void>((resolve) => {
                releaseEncode = resolve;
              });
              await send({ kind: 'encode-checkpoint' });
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  pending,
                  new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error('Owned encode gate deadline')), 5000);
                  }),
                ]);
              } finally {
                if (timer) clearTimeout(timer);
              }
            }
          : undefined,
    });
  }
  route = (await import(
    new URL('../../../../../../web/app/api/auth/[...nextauth]/route.ts', import.meta.url).href
  )) as typeof route;
  const jwt = webRequire('next-auth/jwt') as {
    encode(options: { token: JWT; secret: string; maxAge?: number }): Promise<string>;
    decode(options: { token: string; secret: string }): Promise<JWT | null>;
  };
  phase = 'ready';
  process.on('message', (message: unknown) => {
    void (async () => {
      const command = asRecord(message);
      const id = command.id;
      if (command.action === 'resume-encode') {
        releaseEncode?.();
        return send({ kind: 'reply', id, result: true });
      }
      if (command.action === 'authorize') {
        const result = providers.authorize(
          String(command.url),
          asRecord(command.identity) as unknown as ConfiguredIdentity,
          command.faults ? (asRecord(command.faults) as ConfiguredProviderFaults) : {},
        );
        return send({ kind: 'reply', id, result });
      }
      if (command.action === 'snapshot')
        return send({
          kind: 'reply',
          id,
          result: { ...observations, providerRequests: providers.observations, delegate: delegate?.facts },
        });
      if (command.action === 'decode')
        return send({
          kind: 'reply',
          id,
          result: await jwt.decode({ token: String(command.token), secret: String(input.secret) }),
        });
      if (command.action === 'encode')
        return send({
          kind: 'reply',
          id,
          result: await jwt.encode({ token: asRecord(command.claims), secret: String(input.secret), maxAge: 3600 }),
        });
      if (command.action === 'stop') {
        accepting = false;
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.allSettled(active);
        const { closePool, closeReadPool } = await import('@boardsesh/db/client');
        await Promise.allSettled([closePool(), closeReadPool()]);
        await providers.close();
        await send({ kind: 'stopped', quiescent: active.size === 0 });
        clearTimeout(deadline);
        process.exit(0);
      }
      throw new Error('Unknown owned command');
    })().catch(() => {
      void send({ kind: 'failure', phase });
    });
  });
  await send({ kind: 'ready', origin, providerOrigin: providers.origin });
}

process.once('message', (message) => {
  void start(asRecord(message)).catch(() => {
    void send({ kind: 'failure', phase }).finally(() => process.exit(1));
  });
});
