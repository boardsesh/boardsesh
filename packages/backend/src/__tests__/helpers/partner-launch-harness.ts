import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request, type IncomingHttpHeaders } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { SignJWT } from 'jose';
import * as oauth from 'oauth4webapi';
import { vi } from 'vite-plus/test';
import { users } from '@boardsesh/db/schema/auth';
import { db } from '../../db/client';
import { API_HOSTNAME } from '../../handlers/api-host';

/**
 * The launch suite's harness (F17). Everything here drives the deployed shape:
 * the real `startServer`, real Postgres and Redis, the www session cookie the
 * installed NextAuth writes, and an OAuth client nobody here wrote
 * (oauth4webapi), pointed at `api.boardsesh.com` through a fetch that only
 * changes where the bytes go.
 */

export const ISSUER = new URL('https://api.boardsesh.com/api/auth');
export const RESOURCE = 'https://api.boardsesh.com/v1';
export const WEB_ORIGIN = 'https://www.boardsesh.com';
export const CONSENT_PAGE = `${WEB_ORIGIN}/oauth/consent`;
export const SIGN_IN_PAGE = `${WEB_ORIGIN}/oauth/sign-in`;
export const PARTNER_SECRET = '1:partner-oauth-launch-suite-secret-never-deployed-0123456789';
/** The developer terms this deployment publishes; the shipped version may still be a draft. */
export const LAUNCH_TERMS_VERSION = 'launch-suite-terms-1';
/** The cookie name www sets on `.boardsesh.com` in production. */
export const WWW_SESSION_COOKIE = '__Secure-next-auth.session-token';

const DAY_SECONDS = 24 * 60 * 60;

// The installed NextAuth encoder writes the www session cookie, as www does.
const webRequire = createRequire(new URL('../../../../web/package.json', import.meta.url));
const { encode: encodeNextAuthSession } = webRequire('next-auth/jwt') as {
  encode(this: void, options: { token: Record<string, unknown>; secret: string; maxAge?: number }): Promise<string>;
};

// The web's own switch for guarding OAuth links, read from a web environment.
const WEB_LINK_GUARD_MODULE = new URL('../../../../web/app/lib/auth/partner-link-guard-mode.ts', import.meta.url).href;
type WebLinkGuard = (this: void, environment: NodeJS.ProcessEnv) => boolean;
let webLinkGuard: WebLinkGuard | undefined;
async function webGuardsLinks(webMode: string): Promise<boolean> {
  if (!webLinkGuard) {
    const webModule = (await import(/* @vite-ignore */ WEB_LINK_GUARD_MODULE)) as {
      partnerLinkGuardActive: WebLinkGuard;
    };
    webLinkGuard = webModule.partnerLinkGuardActive;
  }
  // A web service's environment holds only what is set on it; this one, only the mode.
  return webLinkGuard({ PARTNER_OAUTH_MODE: webMode } as unknown as NodeJS.ProcessEnv);
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

// Redis limiter keys outlive a run by up to two minutes, so each run starts at
// its own place in 198.19.0.0/16 (65,536 addresses) rather than at the first one.
let addressCounter = randomInt(0, 65_536);
/** A fresh address per caller, so no Redis bucket is shared with another test or run. */
export function freshClientIp(): string {
  addressCounter = (addressCounter + 1) % 65_536;
  return `198.19.${addressCounter >> 8}.${addressCounter & 255}`;
}

export interface SentResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface SendOptions {
  host?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Stands in for the private ingress appending the client address. */
  clientIp?: string;
}

export function sendTo(port: number, method: string, path: string, options: SendOptions = {}): Promise<SentResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        headers: {
          Host: options.host ?? API_HOSTNAME,
          'X-Forwarded-For': options.clientIp ?? freshClientIp(),
          ...(options.body !== undefined ? { 'Content-Length': String(Buffer.byteLength(options.body)) } : {}),
          ...options.headers,
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end(options.body);
  });
}

function toFetchResponse(sent: SentResponse): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(sent.headers)) {
    if (value === undefined) continue;
    for (const single of Array.isArray(value) ? value : [value]) headers.append(name, single);
  }
  const bodyless = sent.status === 204 || sent.status === 304;
  return new Response(bodyless ? null : sent.body, { status: sent.status, headers });
}

export interface RunningServer {
  port: number;
  send(method: string, path: string, options?: SendOptions): Promise<SentResponse>;
  /** GraphQL on the first-party host, as the app and the website call it. */
  graphql(
    query: string,
    variables?: Record<string, unknown>,
    options?: { bearer?: string; clientIp?: string },
  ): Promise<{ status: number; data?: Record<string, unknown> | null; errors?: GraphQLErrorBody[] }>;
  /** oauth4webapi's fetch: every `https://api.boardsesh.com` request lands on this server. */
  fetchFor(clientIp: string): (url: string, options: oauth.CustomFetchOptions<string, unknown>) => Promise<Response>;
  /** Closes this server's listeners. The process-wide services stay up for the other servers. */
  stop(): Promise<void>;
  /**
   * Stops the services every server in this module graph shares (the event
   * broker's Redis consumer, the room manager). Call once, last, before Redis
   * disconnects, or the consumer loop logs errors and retries after it.
   */
  shutdownProcessServices(): Promise<void>;
}

export interface GraphQLErrorBody {
  message: string;
  extensions?: Record<string, unknown>;
}

/**
 * Points the process at a deployment: the variables a deploy sets, and the
 * developer console's cached reading of them. The OAuth routes and `/v1` read
 * the mode when a server starts; the console reads it on its next call.
 */
export async function useDeployment(environment: Record<string, string>): Promise<void> {
  for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
  const { __resetPartnerRegistrationDeploymentForTests } =
    await import('../../graphql/resolvers/oauth-clients/partner-registration');
  __resetPartnerRegistrationDeploymentForTests();
}

/**
 * Starts the real server with these variables, the way a deploy reads them: the
 * mode is read once here, and registration re-reads its deployment.
 */
export async function startRealServer(environment: Record<string, string>): Promise<RunningServer> {
  await useDeployment({ ...environment, PORT: '0' });
  const { startServer } = await import('../../server');
  // Loopback only. A server on the wildcard address shares its port with any
  // process that binds 127.0.0.1 to the same number, which macOS allows, and a
  // client on 127.0.0.1 then reaches that process instead: a partner test in
  // another worker answered this suite's hold server with its own 401.
  const server = await startServer({ host: '127.0.0.1' });
  if (!server.httpServer.listening) await once(server.httpServer, 'listening');
  const { port } = server.httpServer.address() as AddressInfo;

  const send = (method: string, path: string, options?: SendOptions) => sendTo(port, method, path, options);

  return {
    port,
    send,
    async graphql(query, variables, { bearer, clientIp } = {}) {
      const reply = await send('POST', '/graphql', {
        host: 'ws.boardsesh.com',
        clientIp,
        headers: {
          'Content-Type': 'application/json',
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify({ query, variables }),
      });
      const parsed = (reply.body ? JSON.parse(reply.body) : {}) as {
        data?: Record<string, unknown> | null;
        errors?: GraphQLErrorBody[];
      };
      return { status: reply.status, ...parsed };
    },
    fetchFor(clientIp) {
      return async (url, options) => {
        const target = new URL(url);
        if (target.origin !== 'https://api.boardsesh.com') throw new Error(`Unexpected request to ${target.origin}`);
        // oauth4webapi sends forms as URLSearchParams and nothing else here has a body.
        let body: string | undefined;
        if (options.body instanceof URLSearchParams) body = options.body.toString();
        else if (typeof options.body === 'string') body = options.body;
        else if (options.body !== undefined && options.body !== null) throw new Error('Unexpected request body');
        return toFetchResponse(
          await sendTo(port, options.method, `${target.pathname}${target.search}`, {
            host: target.host,
            headers: options.headers,
            body,
            clientIp,
          }),
        );
      };
    },
    async stop() {
      server.cleanupIntervals();
      await new Promise<void>((resolve) => server.wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
    },
    shutdownProcessServices: () => server.shutdownServices(),
  };
}

/** A first-party bearer token, the kind the app and the website send to GraphQL. */
export function firstPartyToken(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('boardsesh')
    .setAudience('boardsesh-mobile')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.NEXTAUTH_SECRET));
}

export async function createAccount(label: string, { verified = true } = {}): Promise<string> {
  const userId = `${label}-${randomUUID()}`;
  await db.insert(users).values({
    id: userId,
    email: `${userId}@example.invalid`,
    name: label,
    emailVerified: verified ? new Date() : null,
  });
  return userId;
}

export interface WebSignIn {
  /** The web service's own PARTNER_OAUTH_MODE when the sign-in happened. */
  webMode: string;
  /** Seconds since the epoch. Defaults to now. */
  authTime?: number;
  /**
   * A cookie from before the sign-in claims: NextAuth re-issues an old session's
   * cookie on every use without `auth_time` or a login id, which is how every
   * climber's session looks until they next sign in.
   */
  migrated?: { withoutAuthTime?: boolean; withoutLoginId?: boolean };
}

/**
 * The www session cookie a completed sign-in writes. The claims follow the web's
 * jwt callback (`auth-options.ts`): a new login id, `auth_time` at sign-in, and
 * `link_guarded` only when the web's own mode guards links, decided by the web's
 * own function.
 */
export async function signInOnWeb(
  userId: string,
  { webMode, authTime = nowSeconds(), migrated = {} }: WebSignIn,
): Promise<string> {
  const credential = await encodeNextAuthSession({
    token: {
      sub: userId,
      id: userId,
      ...(migrated.withoutLoginId ? {} : { authSessionId: randomUUID() }),
      ...(migrated.withoutAuthTime ? {} : { auth_time: authTime }),
      ...((await webGuardsLinks(webMode)) ? { link_guarded: true } : {}),
    },
    secret: process.env.NEXTAUTH_SECRET ?? '',
    maxAge: 30 * DAY_SECONDS,
  });
  return `${WWW_SESSION_COOKIE}=${credential}`;
}

export interface RegisteredApp {
  clientId: string;
  clientSecret: string | null;
  redirectUris: string[];
  developerId: string;
  developerBearer: string;
}

export const REGISTER_MUTATION = /* GraphQL */ `
  mutation Register($input: CreateOAuthClientInput!) {
    createOAuthClient(input: $input) {
      clientSecret
      client {
        clientId
        redirectUris
        applicationType
        tokenEndpointAuthMethod
        maxActiveConnections
        maxNewConnectionsPerDay
      }
    }
  }
`;
