import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { hash } from 'bcryptjs';
import { and, eq, sql } from 'drizzle-orm';
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import {
  accounts,
  authSubjectCutoffs,
  sessions,
  userCredentials,
  userProfiles,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import type { NextAuthOptions } from '../../../../../../web/node_modules/next-auth';
import type { JWT, JWTDecodeParams, JWTEncodeParams } from '../../../../../../web/node_modules/next-auth/jwt';
import type { Adapter, AdapterUser } from '../../../../../../web/node_modules/next-auth/adapters';
import { db } from '../../../../db/client';
import { reserveEnforcedEmail } from '../../email-reservations';
import type { CurrentStoreTransaction, ExpectedCurrentStoreAuthority } from '../../foundation-context';
import { recordSecurityMutation } from '../../security-mutations';
import type { startLocalOidcFixture } from './local-oidc';

// Resolve only the public exports of the web package's pinned NextAuth4. This
// module is a test fixture, never part of the backend production import graph.
const webRequire = createRequire(new URL('../../../../../../web/package.json', import.meta.url));
const nextAuth = (
  webRequire('next-auth') as {
    default: (request: object, response: object, options: NextAuthOptions) => Promise<void>;
  }
).default;
const publicJwt = webRequire('next-auth/jwt') as {
  encode: (options: JWTEncodeParams) => Promise<string>;
  decode: (options: JWTDecodeParams) => Promise<JWT | null>;
};
const providerId = 'local-oidc';
const cookieName = 'next-auth.session-token';
const purpose = 'ba03-public-nextauth-source-v1';
const sourceLifetimeSeconds = 3600;
const digest = (input: string) => createHash('sha256').update(input).digest('hex');
const sourceKey = (proof: string) => `ba03-lineage:${digest(proof)}`;
const flowKey = (flow: string) => `ba03-flow:${flow}`;

export interface CompoundOutcome {
  readonly user: AdapterUser;
  readonly sourceProof: string;
  readonly sourceSid: string;
  readonly generation: number;
  readonly flow: string;
  readonly createdUser: boolean;
  readonly createdAt: number;
  readonly originalAuthenticatedAt: number | null;
}

interface SourceClaims {
  readonly userId: string;
  readonly sid: string;
  readonly flow: string;
  readonly generation: number;
  readonly expires: number;
  readonly originalAuthenticatedAt: number | null;
}

export interface ProofControls {
  readonly sourceLifetimeSeconds?: number;
  readonly stockLateEventFailure?: boolean;
  readonly failLateEvent?: boolean;
  readonly failEncode?: boolean;
  readonly loseReply?: boolean;
  readonly failBeforeCommit?: boolean;
  readonly beforeEncode?: (outcome: CompoundOutcome) => Promise<void>;
}

function cookiesFromHeader(header: string | undefined): Record<string, string> {
  return Object.fromEntries(
    (header ?? '').split(';').flatMap((part) => {
      const separator = part.indexOf('=');
      if (separator < 1) return [];
      return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]];
    }),
  );
}

function sessionCookie(cookies: Record<string, string>): string | undefined {
  if (cookies[cookieName]) return cookies[cookieName];
  const chunks = Object.entries(cookies)
    .filter(([name]) => new RegExp(`^${cookieName.replaceAll('.', '\\.')}\\.\\d+$`).test(name))
    .sort(([first], [second]) => Number(first.split('.').at(-1)) - Number(second.split('.').at(-1)));
  return chunks.length ? chunks.map(([, chunk]) => chunk).join('') : undefined;
}

function constantEqual(first: string, second: string): boolean {
  const firstBytes = Buffer.from(first);
  const secondBytes = Buffer.from(second);
  return firstBytes.length === secondBytes.length && timingSafeEqual(firstBytes, secondBytes);
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let byteCount = 0;
  const timer = setTimeout(() => request.destroy(new Error('Fixture body deadline')), 2000);
  try {
    for await (const chunk of request as AsyncIterable<unknown>) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Invalid fixture request');
      byteCount += chunk.length;
      if (byteCount > 32_768) throw new Error('Fixture body limit');
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(timer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const parsed: unknown = request.headers['content-type']?.includes('application/json')
    ? JSON.parse(text || '{}')
    : Object.fromEntries(new URLSearchParams(text));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid fixture body');
  return parsed as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, payload: object) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function bufferedResponse() {
  const headers = new Map<string, string | number | readonly string[]>();
  let status = 200;
  let payload: string | undefined;
  const response = {
    status(code: number) {
      status = code;
      return response;
    },
    setHeader(name: string, header: string | number | readonly string[]) {
      headers.set(name.toLowerCase(), header);
      return response;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    end(text?: string) {
      payload = text;
      return response;
    },
    json(content: unknown) {
      headers.set('content-type', 'application/json');
      payload = JSON.stringify(content);
      return response;
    },
    send(content: unknown) {
      payload = typeof content === 'string' ? content : JSON.stringify(content);
      return response;
    },
  };
  return {
    response,
    cookies() {
      const stored = headers.get('set-cookie');
      return Array.isArray(stored) ? [...stored] : typeof stored === 'string' ? [stored] : [];
    },
    publish(target: ServerResponse, stripSession: boolean) {
      for (const [name, header] of headers) {
        if (stripSession && name === 'set-cookie') {
          target.setHeader(
            name,
            this.cookies().filter(
              (cookie) => !cookie.startsWith(`${cookieName}=`) && !cookie.startsWith(`${cookieName}.`),
            ),
          );
        } else target.setHeader(name, header);
      }
      target.statusCode = stripSession ? 503 : status;
      if (stripSession) target.removeHeader('location');
      target.end(stripSession ? 'Fixture issuance denied' : payload);
    },
  };
}

function boundedServer(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) json(response, 500, { error: 'fixture_failure' });
      else response.destroy();
    });
  });
  server.requestTimeout = 8000;
  server.headersTimeout = 8000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return {
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing owned fixture port');
      return `http://127.0.0.1:${address.port}`;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
          reject(new Error('Fixture close deadline'));
        }, 3000);
        server.close((error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      });
    },
  };
}

/** No route imports this module. All keys/roles/URLs belong to disposable tests. */
export async function startNextAuthPublicHandlerProof(options: {
  readonly oidc: Awaited<ReturnType<typeof startLocalOidcFixture>>;
  readonly authority: ExpectedCurrentStoreAuthority;
  readonly writerRole: string;
  readonly controls?: ProofControls;
}) {
  const { oidc, authority, writerRole } = options;
  const controls = { ...options.controls };
  const sourceLifetime = controls.sourceLifetimeSeconds ?? sourceLifetimeSeconds;
  if (!Number.isSafeInteger(sourceLifetime) || sourceLifetime < 1 || sourceLifetime > sourceLifetimeSeconds)
    throw new Error('Invalid proof session lifetime');
  const signingKey = randomBytes(32);
  const nextAuthSecret = randomBytes(32).toString('base64url');
  const rpcSecret = randomBytes(32).toString('base64url');
  const providerJwks = createRemoteJWKSet(new URL(`${oidc.issuer}/jwks`), { timeoutDuration: 3000 });
  const observations = {
    compoundCalls: 0,
    mutationsDenied: [] as string[],
    hookUsers: [] as string[],
    stockIsNewUser: [] as boolean[],
    eventFailures: 0,
    logCodes: [] as string[],
    bufferedSessionCookies: [] as string[],
  };
  const write = <T>(operation: (transaction: CurrentStoreTransaction) => Promise<T>) =>
    db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      await transaction.execute(sql`SET LOCAL lock_timeout = '4000ms'`);
      await transaction.execute(sql`SET LOCAL ROLE ${sql.identifier(writerRole)}`);
      // Shared by admission, reset/deletion and protected validation. Real PG
      // serialization, deliberately coarse and limited to this fixture.
      await transaction.execute(sql`SELECT pg_advisory_xact_lock(6977, 4)`);
      return operation(transaction);
    });

  async function decodeCookie(token: string) {
    return publicJwt.decode({ token, secret: nextAuthSecret });
  }
  async function claimsFor(proof: string): Promise<SourceClaims> {
    const { payload } = await jwtVerify(proof, signingKey, {
      algorithms: ['HS256'],
      issuer: purpose,
      audience: purpose,
    });
    if (
      payload.purpose !== purpose ||
      typeof payload.sub !== 'string' ||
      typeof payload.sid !== 'string' ||
      typeof payload.flow !== 'string' ||
      !/^[a-f0-9]{64}$/.test(payload.flow) ||
      !Number.isSafeInteger(payload.generation) ||
      (payload.generation as number) < 0 ||
      !Number.isSafeInteger(payload.exp) ||
      !(
        payload.originalAuthenticatedAt === null ||
        (Number.isSafeInteger(payload.originalAuthenticatedAt) &&
          (payload.originalAuthenticatedAt as number) >= 0 &&
          (payload.originalAuthenticatedAt as number) <= Date.now())
      )
    )
      throw new Error('Invalid source proof');
    return {
      userId: payload.sub,
      sid: payload.sid,
      flow: payload.flow,
      generation: payload.generation as number,
      expires: (payload.exp as number) * 1000,
      originalAuthenticatedAt: payload.originalAuthenticatedAt as number | null,
    };
  }
  async function validSource(transaction: CurrentStoreTransaction, cookie: string) {
    const decoded = await decodeCookie(cookie);
    if (!decoded || typeof decoded.sourceProof !== 'string') throw new Error('Missing source proof');
    const claims = await claimsFor(decoded.sourceProof);
    if (decoded.sub !== claims.userId || decoded.authSessionId !== claims.sid)
      throw new Error('Cookie source mismatch');
    const [receipt] = await transaction
      .select()
      .from(sessions)
      .where(eq(sessions.sessionToken, sourceKey(decoded.sourceProof)));
    const [flow] = await transaction
      .select()
      .from(verificationTokens)
      .where(
        and(
          eq(verificationTokens.identifier, flowKey(claims.flow)),
          eq(verificationTokens.token, digest(decoded.sourceProof)),
        ),
      );
    const [user] = await transaction.select().from(users).where(eq(users.id, claims.userId));
    const [cutoff] = await transaction
      .select()
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, claims.userId));
    if (
      !receipt ||
      !flow ||
      !user ||
      receipt.userId !== claims.userId ||
      receipt.expires.getTime() !== claims.expires ||
      flow.expires.getTime() < claims.expires ||
      flow.expires.getTime() <= Date.now() ||
      claims.expires <= Date.now() ||
      cutoff?.deletedAt ||
      (cutoff?.generation ?? 0) !== claims.generation
    )
      throw new Error('Revoked source');
    return { claims, user };
  }
  async function abort(sourceProof: string) {
    const source = await claimsFor(sourceProof);
    await write(async (transaction) => {
      await transaction
        .delete(sessions)
        .where(and(eq(sessions.sessionToken, sourceKey(sourceProof)), eq(sessions.userId, source.userId)));
      // Never remove the no-FK flow tombstone; a second code cannot resurrect it.
    });
  }

  const backend = boundedServer(async (request, response) => {
    if (!constantEqual(request.headers.authorization ?? '', `Bearer ${rpcSecret}`))
      return json(response, 401, { error: 'unauthorized' });
    if (request.method !== 'POST' || !['/compound', '/abort'].includes(request.url ?? ''))
      return json(response, 404, {});
    const command = await body(request);
    if (request.url === '/abort') {
      if (Object.keys(command).length !== 1 || typeof command.sourceProof !== 'string')
        return json(response, 400, { error: 'invalid_command' });
      await abort(command.sourceProof);
      return json(response, 200, {});
    }
    if (
      Object.keys(command).some((key) => !['idToken', 'flow', 'actorCookie'].includes(key)) ||
      typeof command.idToken !== 'string' ||
      typeof command.flow !== 'string' ||
      !/^[a-f0-9]{64}$/.test(command.flow) ||
      !(command.actorCookie === null || typeof command.actorCookie === 'string')
    )
      return json(response, 400, { error: 'invalid_command' });
    // The web hook runs only after NextAuth validates nonce/state/PKCE. The
    // authenticated trusted web transport is not a general ID-token exchange.
    const verified = await jwtVerify(command.idToken, providerJwks, {
      algorithms: ['RS256'],
      issuer: oidc.issuer,
      audience: oidc.clientId,
    });
    const profile = verified.payload;
    if (
      typeof profile.sub !== 'string' ||
      (profile.auth_time !== undefined &&
        (!Number.isSafeInteger(profile.auth_time) ||
          (profile.auth_time as number) < 0 ||
          (profile.auth_time as number) * 1000 > Date.now()))
    )
      return json(response, 400, { error: 'invalid_identity' });
    const subject = profile.sub;
    const flow = command.flow;
    const actorCookie = command.actorCookie;
    const outcome = await write(async (transaction): Promise<CompoundOutcome> => {
      observations.compoundCalls += 1;
      const [consumed] = await transaction
        .select()
        .from(verificationTokens)
        .where(eq(verificationTokens.identifier, flowKey(flow)))
        .limit(1);
      if (consumed) throw new Error('Flow consumed');
      const [linked] = await transaction
        .select()
        .from(accounts)
        .where(and(eq(accounts.provider, providerId), eq(accounts.providerAccountId, subject)));
      const actor = typeof actorCookie === 'string' ? await validSource(transaction, actorCookie) : undefined;
      if (actor && (!linked || actor.user.id !== linked.userId)) throw new Error('Explicit link policy required');
      let user: typeof users.$inferSelect;
      let createdUser = false;
      if (linked) {
        const [owner] = await transaction.select().from(users).where(eq(users.id, linked.userId));
        if (!owner) throw new Error('Missing provider owner');
        user = owner;
      } else {
        if (typeof profile.email !== 'string' || !profile.email.trim()) throw new Error('Missing new identity email');
        const userId = randomUUID();
        const reservation = await reserveEnforcedEmail(transaction, {
          ...authority,
          rawEmail: profile.email,
          requestedUserId: userId,
        });
        const [created] = await transaction
          .insert(users)
          .values({
            id: userId,
            email: reservation.normalizedEmail,
            name: typeof profile.name === 'string' ? profile.name : null,
            emailVerified: null,
          })
          .returning();
        if (!created) throw new Error('Missing created user');
        user = created;
        await transaction.insert(userProfiles).values({ userId, displayName: user.name });
        await transaction
          .insert(accounts)
          .values({ userId, provider: providerId, providerAccountId: subject, type: 'oauth' });
        createdUser = true;
      }
      const [cutoff] = await transaction
        .select()
        .from(authSubjectCutoffs)
        .where(eq(authSubjectCutoffs.userId, user.id));
      if (cutoff?.deletedAt) throw new Error('Deleted owner');
      const generation = cutoff?.generation ?? 0;
      const sourceSid = randomUUID();
      const originalAuthenticatedAt = profile.auth_time === undefined ? null : (profile.auth_time as number) * 1000;
      const expires = Math.floor(Date.now() / 1000) + sourceLifetime;
      // State validity is 15 minutes; even short-lived source tests retain the
      // consumed flow for a full hour. No cleanup implementation is claimed.
      const flowExpires = Math.floor(Date.now() / 1000) + sourceLifetimeSeconds;
      const sourceProof = await new SignJWT({ purpose, sid: sourceSid, generation, flow, originalAuthenticatedAt })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer(purpose)
        .setAudience(purpose)
        .setSubject(user.id)
        .setIssuedAt()
        .setExpirationTime(expires)
        .sign(signingKey);
      await transaction
        .insert(sessions)
        .values({ sessionToken: sourceKey(sourceProof), userId: user.id, expires: new Date(expires * 1000) });
      await transaction
        .insert(verificationTokens)
        .values({ identifier: flowKey(flow), token: digest(sourceProof), expires: new Date(flowExpires * 1000) });
      if (controls.failBeforeCommit) throw new Error('Injected compound rollback');
      return {
        user,
        sourceProof,
        sourceSid,
        generation,
        flow,
        createdUser,
        createdAt: user.createdAt.getTime(),
        originalAuthenticatedAt,
      };
    });
    if (controls.loseReply) {
      response.destroy();
      return;
    }
    json(response, 200, outcome);
  });
  let backendOrigin: string | undefined;
  let webOrigin = '';

  const readOnlyAdapter: Adapter = {
    async getUser(userId) {
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      return user ?? null;
    },
    async getUserByAccount(account) {
      const [linked] = await db
        .select({ user: users })
        .from(accounts)
        .innerJoin(users, eq(accounts.userId, users.id))
        .where(and(eq(accounts.provider, account.provider), eq(accounts.providerAccountId, account.providerAccountId)));
      return linked?.user ?? null;
    },
    async getUserByEmail(email) {
      const [user] = await db.select().from(users).where(eq(users.email, email));
      return user ?? null;
    },
    async createUser() {
      observations.mutationsDenied.push('createUser');
      throw new Error('Adapter writes disabled');
    },
    async updateUser() {
      observations.mutationsDenied.push('updateUser');
      throw new Error('Adapter writes disabled');
    },
    async linkAccount() {
      observations.mutationsDenied.push('linkAccount');
      throw new Error('Adapter writes disabled');
    },
    async deleteUser() {
      observations.mutationsDenied.push('deleteUser');
      throw new Error('Adapter writes disabled');
    },
    async unlinkAccount() {
      observations.mutationsDenied.push('unlinkAccount');
      throw new Error('Adapter writes disabled');
    },
    async createSession() {
      observations.mutationsDenied.push('createSession');
      throw new Error('Adapter writes disabled');
    },
    async updateSession() {
      observations.mutationsDenied.push('updateSession');
      throw new Error('Adapter writes disabled');
    },
    async deleteSession() {
      observations.mutationsDenied.push('deleteSession');
      throw new Error('Adapter writes disabled');
    },
  };
  const web = boundedServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', webOrigin);
    const requestCookies = cookiesFromHeader(request.headers.cookie);
    if (requestUrl.pathname === '/protected') {
      try {
        const cookie = sessionCookie(requestCookies);
        if (!cookie) throw new Error('No cookie');
        const current = await write((transaction) => validSource(transaction, cookie));
        return json(response, 200, {
          userId: current.user.id,
          sourceSid: current.claims.sid,
          originalAuthenticatedAt: current.claims.originalAuthenticatedAt,
        });
      } catch {
        return json(response, 401, { error: 'invalid_session' });
      }
    }
    if (
      !['/api/auth/csrf', `/api/auth/signin/${providerId}`, `/api/auth/callback/${providerId}`].includes(
        requestUrl.pathname,
      )
    )
      return json(response, 404, {});
    // Every field here belongs to ONE actual HTTP request, including concurrent
    // callbacks with different cookies and different backend outcomes.
    let outcome: CompoundOutcome | undefined;
    let failed = false;
    const incomingActor = sessionCookie(requestCookies) ?? null;
    const buffered = bufferedResponse();
    const authOptions: NextAuthOptions = {
      secret: nextAuthSecret,
      useSecureCookies: false,
      session: { strategy: 'jwt', maxAge: sourceLifetimeSeconds },
      adapter: readOnlyAdapter,
      providers: [
        {
          id: providerId,
          name: 'Local proof OIDC',
          type: 'oauth',
          wellKnown: oidc.discoveryUrl,
          clientId: oidc.clientId,
          clientSecret: oidc.clientSecret,
          checks: ['pkce', 'state', 'nonce'],
          idToken: true,
          authorization: { params: { scope: 'openid email profile' } },
          profile(profile: Record<string, unknown>) {
            return {
              id: String(profile.sub),
              email: typeof profile.email === 'string' ? profile.email : null,
              name: typeof profile.name === 'string' ? profile.name : null,
            };
          },
        },
      ],
      logger: {
        error(code) {
          observations.logCodes.push(code);
        },
        warn() {},
        debug() {},
      },
      callbacks: {
        async signIn({ user, account }) {
          observations.hookUsers.push(user.id);
          if (
            !account ||
            account.provider !== providerId ||
            !('id_token' in account) ||
            typeof account.id_token !== 'string'
          )
            return false;
          const states = requestUrl.searchParams.getAll('state');
          if (states.length !== 1 || !states[0]) return false;
          const result = await fetch(`${backendOrigin}/compound`, {
            method: 'POST',
            headers: { authorization: `Bearer ${rpcSecret}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              idToken: account.id_token,
              flow: digest(`${providerId}\0${states[0]}`),
              actorCookie: incomingActor,
            }),
            signal: AbortSignal.timeout(6000),
          });
          if (!result.ok) return false;
          const received = (await result.json()) as CompoundOutcome;
          // JSON dates in the returned user must regain the adapter Date type.
          outcome = {
            ...received,
            user: {
              ...received.user,
              emailVerified: received.user.emailVerified ? new Date(received.user.emailVerified) : null,
            },
          };
          return true;
        },
        async jwt({ token, user, isNewUser }) {
          if (user) {
            if (!outcome || user.id !== outcome.user.id) throw new Error('Missing exact backend outcome');
            observations.stockIsNewUser.push(Boolean(isNewUser));
            return {
              ...token,
              sub: outcome.user.id,
              sourceProof: outcome.sourceProof,
              authSessionId: outcome.sourceSid,
              accountCreated: outcome.createdUser,
              accountCreatedAt: outcome.createdAt,
              originalAuthenticatedAt: outcome.originalAuthenticatedAt,
            };
          }
          return token;
        },
      },
      jwt: {
        async encode(parameters) {
          if (typeof parameters.token?.sourceProof !== 'string') return publicJwt.encode(parameters);
          try {
            if (!outcome) throw new Error('Missing local outcome');
            await controls.beforeEncode?.(outcome);
            if (controls.failEncode) {
              // A cyclic synthetic claim makes the REAL public encoder's JSON
              // serialization fail. No library mock or dependency patch.
              const invalidToken: JWT = { ...parameters.token };
              invalidToken.fixtureCycle = invalidToken;
              return await publicJwt.encode({ ...parameters, token: invalidToken });
            }
            return await publicJwt.encode(parameters);
          } catch (error) {
            // NextAuth catches encoder failures and resolves an error redirect.
            // Preserve the failure before it crosses that library boundary.
            failed = true;
            throw error;
          }
        },
        decode: publicJwt.decode,
      },
      events: {
        async createUser() {
          observations.mutationsDenied.push('events.createUser');
          throw new Error('Backend owns profile creation');
        },
        async linkAccount() {
          observations.mutationsDenied.push('events.linkAccount');
          throw new Error('Backend owns account link');
        },
        async signIn() {
          if (controls.failLateEvent) {
            observations.eventFailures += 1;
            failed = true;
            throw new Error('Injected late event failure');
          }
        },
      },
    };
    try {
      await nextAuth(
        {
          method: request.method,
          headers: {
            ...request.headers,
            host: new URL(webOrigin).host,
            'x-forwarded-host': new URL(webOrigin).host,
            'x-forwarded-proto': 'http',
          },
          cookies: requestCookies,
          query: {
            ...Object.fromEntries(requestUrl.searchParams),
            nextauth: requestUrl.pathname.slice('/api/auth/'.length).split('/'),
          },
          body: request.method === 'POST' ? await body(request) : undefined,
        },
        buffered.response,
        authOptions,
      );
    } catch {
      failed = true;
    }
    observations.bufferedSessionCookies.push(
      ...buffered
        .cookies()
        .filter((cookie) => cookie.startsWith(`${cookieName}=`) || cookie.startsWith(`${cookieName}.`)),
    );
    // A thrown event is swallowed by NextAuth. Observe our own hook failure;
    // status/redirect alone cannot define successful publication.
    const denied = failed && !controls.stockLateEventFailure;
    if (denied && outcome) {
      const revoked = await fetch(`${backendOrigin}/abort`, {
        method: 'POST',
        headers: { authorization: `Bearer ${rpcSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sourceProof: outcome.sourceProof }),
        signal: AbortSignal.timeout(6000),
      });
      if (!revoked.ok) throw new Error('Fixture issuance abort failed');
    }
    buffered.publish(response, denied);
  });
  try {
    backendOrigin = await backend.listen();
    webOrigin = await web.listen();
    oidc.registerRedirectUri(`${webOrigin}/api/auth/callback/${providerId}`);
  } catch (error) {
    await Promise.allSettled([web.close(), backend.close()]);
    throw error;
  }
  return {
    origin: webOrigin,
    backendOrigin,
    // Tests may exercise trusted transport validation without exposing its key.
    async trustedRpc(command: Record<string, unknown>, path: '/compound' | '/abort' = '/compound') {
      return fetch(`${backendOrigin}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${rpcSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(6000),
      });
    },
    observations,
    decodeCookie,
    async protected(cookie: string) {
      return fetch(`${webOrigin}/protected`, { headers: { cookie }, signal: AbortSignal.timeout(6000) });
    },
    async reset(userId: string, deletion = false) {
      const replacementHash = deletion ? undefined : await hash('proof-reset-replacement-password', 4);
      return write(async (transaction) => {
        const [current] = await transaction
          .select()
          .from(authSubjectCutoffs)
          .where(eq(authSubjectCutoffs.userId, userId));
        const mutation = await recordSecurityMutation(transaction, {
          ...authority,
          userId,
          expectedGeneration: current?.generation ?? 0,
          operationId: randomUUID(),
          kind: deletion ? 'account-deletion' : 'password-reset',
          domains: ['first-party', 'partner'],
        });
        if (deletion) await transaction.delete(users).where(eq(users.id, userId));
        else
          await transaction
            .insert(userCredentials)
            .values({ userId, passwordHash: replacementHash! })
            .onConflictDoUpdate({ target: userCredentials.userId, set: { passwordHash: replacementHash! } });
        return mutation;
      });
    },
    async close() {
      const results = await Promise.allSettled([web.close(), backend.close()]);
      if (results.some((result) => result.status === 'rejected')) throw new Error('Owned HTTP fixture cleanup failed');
    },
  };
}

/** Small real HTTP cookie jar; actual cookie chunks are inspected by tests. */
export class ProofBrowser {
  readonly cookies = new Map<string, string>();
  constructor(readonly origin: string) {}
  header() {
    return [...this.cookies].map(([name, cookie]) => `${name}=${cookie}`).join('; ');
  }
  sessionHeader() {
    return [...this.cookies]
      .filter(([name]) => name === cookieName || name.startsWith(`${cookieName}.`))
      .map(([name, cookie]) => `${name}=${cookie}`)
      .join('; ');
  }
  async request(url: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('cookie', this.header());
    const response = await fetch(url, {
      ...init,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(7000),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const content = pair.slice(separator + 1);
      if (content === '') this.cookies.delete(name);
      else this.cookies.set(name, content);
    }
    return response;
  }
  async start() {
    const csrfResponse = await this.request(`${this.origin}/api/auth/csrf`);
    const csrf = (await csrfResponse.json()) as { csrfToken: string };
    const response = await this.request(`${this.origin}/api/auth/signin/${providerId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrfToken: csrf.csrfToken, callbackUrl: `${this.origin}/signed-in` }),
    });
    const destination = response.headers.get('location');
    if (!destination || !destination.includes('/authorize')) throw new Error('Public handler did not start OIDC');
    return destination;
  }
}
