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
import type { NextRequest } from '../../../../../../web/node_modules/next/server';
import { ownedAppRouterDatabase } from './app-router-owned-db';
import { installAppRouterFixtureDelegate } from './app-router-delegate';
import { observeSessionPublication } from './session-publication-observer';
import { installWebOAuthConsoleObserver } from './web-oauth-console-observer';

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
  if (input.webOAuthIdentity && (input.compound || input.sessionPublicationProof))
    throw new Error('Owned identity proof requires its independent route mode');
  const webOAuthIdentity = input.webOAuthIdentity ? asRecord(input.webOAuthIdentity) : undefined;
  const compound = input.compound ? asRecord(input.compound) : undefined;
  for (const backend of [webOAuthIdentity, compound]) {
    if (!backend) continue;
    if (typeof backend.origin !== 'string') throw new Error('Owned backend origin required');
    const destination = new URL(backend.origin);
    if (
      destination.origin !== backend.origin ||
      destination.protocol !== 'http:' ||
      destination.hostname !== '127.0.0.1' ||
      !destination.port ||
      Number(destination.port) < 1024 ||
      destination.username ||
      destination.password ||
      destination.pathname !== '/' ||
      destination.search ||
      destination.hash
    )
      throw new Error('Unowned backend origin refused');
  }
  const webOAuthConsole = webOAuthIdentity ? installWebOAuthConsoleObserver() : undefined;
  phase = 'provider';
  const providers = await startConfiguredProviderTransport();
  let route: {
    GET(request: NextRequest, context: object): Promise<Response>;
    POST(request: NextRequest, context: object): Promise<Response>;
  };
  let origin = '';
  let peerOrigin = '';
  let peerServer: https.Server | undefined;
  let admissionServer: http.Server | undefined;
  let admissionOrigin = '';
  let delegate: ReturnType<typeof installAppRouterFixtureDelegate> | undefined;
  let publicationObserver: ReturnType<typeof observeSessionPublication> | undefined;
  let releaseEncode: (() => void) | undefined;
  let armedResponseGate: string | undefined;
  const responseGates = new Map<string, { pending: Promise<void>; release(): void }>();
  const observations = {
    events: [] as string[],
    logs: [] as string[],
    signIns: [] as { provider: string; userId: string }[],
    transports: [] as { method: string; path: string; session: boolean; state: boolean; pkce: boolean }[],
    providerRedirects: [] as { official: boolean; cookiesPreserved: boolean; count: number }[],
    forwardedCookies: [] as { preserved: boolean; count: number }[],
    responseGates: [] as {
      gateId: string;
      headersSent: boolean;
      status: number;
      authCookieCount: number;
      clearingAuthCookies: boolean;
      released: boolean;
    }[],
    admission: {
      statuses: [] as number[],
      unavailableResponses: 0,
      activityPermissionDeniedLogs: 0,
      activityOtherFailure: 0,
    },
  };
  const server = https.createServer(providers.tls, (request, response) => {
    if (!accepting) {
      response.destroy();
      return;
    }
    const pending = (async () => {
      const requestUrl = request.url;
      if (!requestUrl) {
        response.writeHead(404).end();
        return;
      }
      const proofPath =
        input.sessionPublicationProof === true &&
        ['/__proof/server-session', '/__proof/page'].includes(requestUrl.split('?')[0]) &&
        request.method === 'GET';
      if (!requestUrl.startsWith('/api/auth/') && !requestUrl.startsWith('/__proof/continue/') && !proofPath) {
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
      let current = new RequestConstructor(new URL(requestUrl, origin), {
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
      const result = await requestStorage.run(current, async () => {
        if (input.sessionPublicationProof === true && current.nextUrl.pathname === '/__proof/server-session') {
          const { getServerSession } = webRequire(
            'next-auth/next',
          ) as typeof import('../../../../../../web/node_modules/next-auth/next');
          return Response.json(await getServerSession(options));
        }
        if (input.sessionPublicationProof === true && current.nextUrl.pathname === '/__proof/page')
          return new Response('<!doctype html><html><body>Owned publication proof page</body></html>', {
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
          });
        return delegate ? delegate.run(current, invoke) : invoke();
      });
      if (
        input.sessionPublicationProof === true &&
        armedResponseGate &&
        current.method === 'GET' &&
        current.nextUrl.pathname === '/api/auth/session'
      ) {
        const gateId = armedResponseGate;
        armedResponseGate = undefined;
        const gate = responseGates.get(gateId);
        if (!gate) throw new Error('Missing owned publication response gate');
        const authCookies = result.headers
          .getSetCookie()
          .filter((header) => /^(?:__Secure-)?next-auth\.session-token(?:\.\d+)?=/.test(header));
        const observation = {
          gateId,
          headersSent: response.headersSent,
          status: result.status,
          authCookieCount: authCookies.length,
          clearingAuthCookies: authCookies.some((header) => /;\s*Max-Age=0(?:;|$)/i.test(header)),
          released: false,
        };
        observations.responseGates.push(observation);
        await send({ kind: 'response-checkpoint', ...observation });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            gate.pending,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Owned publication response gate deadline')), 5000);
            }),
          ]);
          observation.released = true;
        } finally {
          if (timer) clearTimeout(timer);
          responseGates.delete(gateId);
        }
      }
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
  if (input.sessionPublicationProof === true) {
    if (input.compound) throw new Error('Publication proof requires unchanged stock authority');
    // A second same-site origin supplies only an owned browser page. Actual
    // authentication still reaches the first listener's public route exports.
    peerServer = https.createServer(providers.tls, (request, response) => {
      if (!accepting || request.method !== 'GET' || request.url !== '/__proof/page') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('<!doctype html><html><body>Owned same-site peer page</body></html>');
    });
    peerServer.requestTimeout = 8000;
    peerServer.headersTimeout = 8000;
    peerServer.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      peerServer!.once('error', reject);
      peerServer!.listen(0, '127.0.0.1', resolve);
    });
    const peerAddress = peerServer.address();
    if (!peerAddress || typeof peerAddress === 'string') throw new Error('Owned peer bind failed');
    peerOrigin = `https://localhost:${peerAddress.port}`;
  }
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
    // Authentication must use this role's primary, never an accidental replica.
    READ_REPLICA_URL: 'postgresql://owned:unused@127.0.0.1:1/unused',
    DEBUG_SQL: 'false',
    CURRENT_STORE_WEB_AUTH_MODE: 'legacy',
    CURRENT_STORE_WEB_OAUTH_MODE: webOAuthIdentity ? 'backend-staging' : 'legacy',
    CURRENT_STORE_AUTH_BACKEND_ORIGIN: webOAuthIdentity ? String(webOAuthIdentity.origin) : '',
    CURRENT_STORE_AUTH_RPC_SECRET: webOAuthIdentity ? String(webOAuthIdentity.secret) : '',
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
  let yoga: ReturnType<typeof import('../../../../graphql/yoga').createYogaInstance> | undefined;
  admissionServer = http.createServer((request, response) => {
    if (!accepting || request.method !== 'POST' || request.url !== '/graphql') {
      response.writeHead(404).end();
      return;
    }
    response.once('finish', () => observations.admission.statuses.push(response.statusCode));
    const pending = (async () => {
      try {
        const currentYoga = yoga;
        if (!currentYoga) throw new Error('Owned admission is not ready');
        await currentYoga.handle(request, response);
      } catch {
        if (!response.headersSent) response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'unavailable' }));
      }
    })();
    active.add(pending);
    void pending.finally(() => active.delete(pending));
  });
  admissionServer.requestTimeout = 5000;
  admissionServer.headersTimeout = 5000;
  admissionServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    admissionServer!.once('error', reject);
    admissionServer!.listen(0, '127.0.0.1', resolve);
  });
  const admissionAddress = admissionServer.address();
  if (!admissionAddress || typeof admissionAddress === 'string') throw new Error('Owned admission bind failed');
  admissionOrigin = `http://127.0.0.1:${admissionAddress.port}`;
  process.env.BACKEND_INTERNAL_URL = `${admissionOrigin}/graphql`;
  process.env.NEXT_PUBLIC_WS_URL = `${admissionOrigin.replace('http:', 'ws:')}/graphql`;
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
  globalThis.fetch = async (address, settings) => {
    const destination = new URL(typeof address === 'string' || address instanceof URL ? address : address.url);
    const allowedCompound =
      compound &&
      destination.origin === compound.origin &&
      ['/intent', '/compound', '/abort', '/validate'].includes(destination.pathname);
    const allowedWebIdentity =
      webOAuthIdentity &&
      destination.origin === webOAuthIdentity.origin &&
      [
        '/api/internal/auth/current-store/web-oauth/v1/intent',
        '/api/internal/auth/current-store/web-oauth/v1/resolve',
      ].includes(destination.pathname);
    const allowedAdmission =
      destination.origin === admissionOrigin && destination.pathname === '/graphql' && settings?.method === 'POST';
    if (
      (!allowedCompound && !allowedWebIdentity && !allowedAdmission) ||
      destination.search ||
      destination.hash ||
      destination.username ||
      destination.password
    )
      throw new Error('Unowned fetch refused');
    const response = await originalFetch(address, { ...settings, redirect: 'error' });
    if (allowedAdmission && response.status === 503) {
      const result = asRecord(await response.clone().json());
      if (
        Array.isArray(result.errors) &&
        result.errors.some((error: unknown) => {
          const extensions = asRecord(asRecord(error).extensions);
          return extensions.code === 'SERVICE_UNAVAILABLE';
        })
      )
        observations.admission.unavailableResponses += 1;
    }
    if (
      allowedWebIdentity &&
      destination.pathname.endsWith('/resolve') &&
      response.status === 200 &&
      input.faults &&
      asRecord(input.faults).discardSuccessfulWebOAuthResponse === true
    ) {
      await response.arrayBuffer();
      throw new Error('Owned web identity response discarded');
    }
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
  phase = 'admission-load';
  // The real transport, crypto validation, fresh primary deletion read, and
  // mounted resolver all run in this restricted-role child. Importing Yoga
  // does not initialize the backend server's Redis or background services.
  const { createYogaInstance } = await import('../../../../graphql/yoga');
  const { logger } = await import('../../../../utils/logger');
  const { getPostgresErrorCode } = await import('../../../../utils/postgres-errors');
  // Observe instrumentation failures without retaining SQL, owners, or tokens.
  // The activity recorder is deliberately denied INSERT by the existing role.
  const observeActivityFailure = (entry: Record<string | symbol, unknown>) => {
    if (typeof entry.message !== 'string' || !entry.message.startsWith('[UserActivity] Failed to record user activity'))
      return;
    const error = entry[Symbol.for('boardsesh.errorInstance')] ?? entry;
    if (getPostgresErrorCode(error) === '42501') observations.admission.activityPermissionDeniedLogs += 1;
    else observations.admission.activityOtherFailure += 1;
  };
  logger.on('data', observeActivityFailure);
  yoga = createYogaInstance();
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
  const jwt = webRequire('next-auth/jwt') as typeof import('../../../../../../web/node_modules/next-auth/jwt');
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
      if (webOAuthIdentity && input.faults && asRecord(input.faults).failEvent === true)
        throw new Error('Owned late sign-in event failed');
    },
  };
  options.logger = {
    error(code) {
      observations.logs.push(code);
    },
    warn() {},
    debug() {},
  };
  if (webOAuthIdentity && input.faults && asRecord(input.faults).failEncode === true) {
    options.jwt = {
      ...options.jwt,
      async encode() {
        throw new Error('Owned late identity encode failed');
      },
    };
  }
  if (input.sessionPublicationProof === true) publicationObserver = observeSessionPublication(options, jwt);
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
  phase = 'ready';
  process.on('message', (message: unknown) => {
    void (async () => {
      const command = asRecord(message);
      const id = command.id;
      if (command.action === 'arm-session-response') {
        if (
          input.sessionPublicationProof !== true ||
          armedResponseGate ||
          responseGates.size ||
          typeof command.gateId !== 'string' ||
          !/^[a-f0-9-]{36}$/i.test(command.gateId)
        )
          throw new Error('Invalid owned publication gate');
        let release = () => {};
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        responseGates.set(command.gateId, { pending, release });
        armedResponseGate = command.gateId;
        return send({ kind: 'reply', id, result: true });
      }
      if (command.action === 'release-session-response') {
        if (input.sessionPublicationProof !== true || typeof command.gateId !== 'string')
          throw new Error('Invalid owned publication release');
        const gate = responseGates.get(String(command.gateId));
        if (armedResponseGate === command.gateId) {
          armedResponseGate = undefined;
          responseGates.delete(command.gateId);
        }
        gate?.release();
        return send({ kind: 'reply', id, result: Boolean(gate) });
      }
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
          result: {
            ...observations,
            providerRequests: providers.observations,
            delegate: delegate?.facts,
            sessionPublication: publicationObserver?.snapshot(),
            webOAuthConsole: webOAuthConsole?.snapshot(),
          },
        });
      if (command.action === 'decode')
        return send({
          kind: 'reply',
          id,
          result: await jwt.decode({ token: String(command.token), secret: String(input.secret) }),
        });
      if (command.action === 'encode') {
        let maxAge = 3600;
        if (command.maxAge !== undefined) {
          if (
            input.sessionPublicationProof !== true ||
            typeof command.maxAge !== 'number' ||
            !Number.isFinite(command.maxAge) ||
            command.maxAge < -86400 ||
            command.maxAge > 2592000
          )
            throw new Error('Invalid owned encode lifetime');
          maxAge = command.maxAge;
        }
        return send({
          kind: 'reply',
          id,
          result: await jwt.encode({ token: asRecord(command.claims), secret: String(input.secret), maxAge }),
        });
      }
      if (command.action === 'stop') {
        accepting = false;
        for (const gate of responseGates.values()) gate.release();
        server.closeAllConnections();
        peerServer?.closeAllConnections();
        admissionServer?.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (peerServer) await new Promise<void>((resolve) => peerServer!.close(() => resolve()));
        if (admissionServer) await new Promise<void>((resolve) => admissionServer!.close(() => resolve()));
        await Promise.allSettled(active);
        logger.removeListener('data', observeActivityFailure);
        const { closePool, closeReadPool } = await import('@boardsesh/db/client');
        const { closeAdmissionPool } = await import('../../../admission-pool');
        await Promise.allSettled([closePool(), closeReadPool(), closeAdmissionPool()]);
        await providers.close();
        webOAuthConsole?.restore();
        await send({ kind: 'stopped', quiescent: active.size === 0 });
        clearTimeout(deadline);
        process.exit(0);
      }
      throw new Error('Unknown owned command');
    })().catch(() => {
      void send({ kind: 'failure', phase });
    });
  });
  await send({ kind: 'ready', origin, providerOrigin: providers.origin, ...(peerOrigin ? { peerOrigin } : {}) });
}

process.once('message', (message) => {
  void start(asRecord(message)).catch(() => {
    void send({ kind: 'failure', phase }).finally(() => process.exit(1));
  });
});
