import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { authSubjectCutoffs, userCredentials, userProfiles, users } from '@boardsesh/db/schema/auth';
import { sql, type SQL } from 'drizzle-orm';
import type { NextAuthOptions } from '../../../../../web/node_modules/next-auth';
import type * as PublicJwt from '../../../../../web/node_modules/next-auth/jwt';
import { db } from '../../../db/client';
import { setupWorkerDatabase } from '../../../__tests__/worker-db';
import { RouteExportBrowser, startAppRouterHarness } from './fixtures/app-router-harness';
import { observeSessionPublication } from './fixtures/session-publication-observer';

type Observations = ReturnType<ReturnType<typeof observeSessionPublication>['snapshot']>;
const role = `ba03_router_readonly_${randomUUID().replaceAll('-', '')}`;
const password = randomBytes(32).toString('hex');
const readTables = [users, userProfiles, userCredentials, authSubjectCutoffs];
const ownerId = randomUUID();
const sessionId = randomUUID();
const thirtyDays = 30 * 24 * 60 * 60;
const cookieName = '__Secure-next-auth.session-token';
let tracked = false;
let harness: Awaited<ReturnType<typeof startAppRouterHarness>> | undefined;

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
async function admin(statement: SQL) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout='5000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout='4000ms'`);
    return transaction.execute(statement);
  });
}
function ownedHarness() {
  if (!harness) throw new Error('Missing session publication fixture');
  return harness;
}
async function snapshot(): Promise<Observations> {
  const result = (await ownedHarness().call('snapshot')) as { sessionPublication: Observations };
  return result.sessionPublication;
}
async function parent(name = 'Owned Session Climber') {
  return String(
    await ownedHarness().call('encode', {
      claims: { sub: ownerId, id: ownerId, name, authSessionId: sessionId },
      maxAge: 24 * 60 * 60,
    }),
  );
}
function browser(token: string) {
  const current = new RouteExportBrowser(ownedHarness());
  current.cookies.set(cookieName, token);
  return current;
}

describe('actual server reads versus public cookie publication', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
    await db.transaction(async (transaction) => {
      await transaction.execute(
        sql`CREATE ROLE ${sql.identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${password}'`)}`,
      );
      tracked = true;
      await transaction.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(role)}`);
      await transaction.execute(sql`GRANT SELECT ON TABLE ${sql.join(readTables, sql`, `)} TO ${sql.identifier(role)}`);
    });
    const database = new URL(process.env.DATABASE_URL ?? '');
    database.username = role;
    database.password = password;
    harness = await startAppRouterHarness({ databaseUrl: database.href, sessionPublicationProof: true });
  }, 30000);
  beforeEach(async () => {
    await db.delete(users);
    await db.insert(users).values({ id: ownerId, email: `${ownerId}@example.test` });
    await db.insert(userProfiles).values({ userId: ownerId });
  });
  afterAll(async () => {
    const failures: Error[] = [];
    try {
      await harness?.close();
    } catch {
      failures.push(new Error('Session fixture cleanup failed'));
    }
    if (tracked) {
      try {
        await admin(sql`REVOKE ALL PRIVILEGES ON TABLE ${sql.join(readTables, sql`, `)} FROM ${sql.identifier(role)}`);
        await admin(sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${sql.identifier(role)}`);
        await admin(sql`DROP ROLE ${sql.identifier(role)}`);
      } catch {
        failures.push(new Error('Session reader role cleanup failed'));
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Session publication cleanup failed');
  });

  it('one-argument getServerSession decodes the raw JWE and encodes a different JWE without publishing it', async () => {
    const original = await parent();
    const before = await snapshot();
    const result = await ownedHarness().request('/__proof/server-session', { cookie: `${cookieName}=${original}` });
    expect(result.status).toBe(200);
    const session = JSON.parse(result.body) as { user: { id: string }; authSessionId: string; expires?: string };
    expect(session.user.id).toBe(ownerId);
    expect(session.authSessionId).toBe(sessionId);
    expect(session.expires).toBeUndefined();
    expect(result.cookies.length).toBe(0);
    const after = await snapshot();
    const encoded = after.encodes.slice(before.encodes.length);
    expect(encoded).toHaveLength(1);
    expect(encoded[0]).toMatchObject({
      userId: ownerId,
      authSessionId: sessionId,
      maxAge: thirtyDays,
      observationFailed: false,
    });
    expect(encoded[0].tokenDigest).not.toBe(digest(original));
    expect(
      after.decodes
        .slice(before.decodes.length)
        .some((entry) => entry.tokenDigest === digest(original) && entry.userId === ownerId && !entry.failed),
    ).toBe(true);
  });

  it('repeated server reads create distinct unpublished encodings while reading the same presented cookie', async () => {
    const original = await parent();
    const before = await snapshot();
    for (let read = 0; read < 3; read += 1) {
      const result = await ownedHarness().request('/__proof/server-session', { cookie: `${cookieName}=${original}` });
      expect(result.status).toBe(200);
      expect(result.cookies.length).toBe(0);
    }
    const after = await snapshot();
    const generated = after.encodes.slice(before.encodes.length);
    expect(generated).toHaveLength(3);
    expect(new Set(generated.map((entry) => entry.tokenDigest)).size).toBe(3);
    expect(
      generated.every(
        (entry) => entry.userId === ownerId && entry.authSessionId === sessionId && entry.maxAge === thirtyDays,
      ),
    ).toBe(true);
    expect(
      after.decodes.slice(before.decodes.length).filter((entry) => entry.tokenDigest === digest(original)),
    ).toHaveLength(3);
  });

  it('actual public GET renews a one-day parent for a full thirty days and publishes the exact observed JWE', async () => {
    const original = await parent();
    const originalClaims = (await ownedHarness().call('decode', { token: original })) as { exp: number };
    const current = browser(original);
    const before = await snapshot();
    const earliest = Math.floor(Date.now() / 1000);
    const result = await current.request('/api/auth/session');
    const latest = Math.floor(Date.now() / 1000);
    expect(result.status).toBe(200);
    expect(result.cookies.some((header) => header.startsWith(`${cookieName}=`) && /HttpOnly/i.test(header))).toBe(true);
    const renewed = current.session();
    expect(renewed !== original).toBe(true);
    const claims = (await current.claims()) as { sub: string; authSessionId: string; iat: number; exp: number };
    expect(claims.sub).toBe(ownerId);
    expect(claims.authSessionId).toBe(sessionId);
    expect(claims.exp).toBeGreaterThan(originalClaims.exp);
    expect(claims.exp).toBeGreaterThanOrEqual(earliest + thirtyDays);
    expect(claims.exp).toBeLessThanOrEqual(latest + thirtyDays);
    const encoded = (await snapshot()).encodes.slice(before.encodes.length);
    expect(encoded).toHaveLength(1);
    expect(encoded[0]).toMatchObject({
      tokenDigest: digest(renewed),
      issuedAt: claims.iat,
      expiresAt: claims.exp,
      maxAge: thirtyDays,
    });
    expect(((await ownedHarness().call('decode', { token: original })) as { sub: string }).sub).toBe(ownerId);
  });

  it('actual POST session update publishes renewal without accepting a client-selected owner or SID', async () => {
    const current = browser(await parent());
    const csrf = await current.request('/api/auth/csrf');
    const csrfToken = (JSON.parse(csrf.body) as { csrfToken: string }).csrfToken;
    const before = await snapshot();
    const earliest = Math.floor(Date.now() / 1000);
    const result = await ownedHarness().request('/api/auth/session', {
      method: 'POST',
      cookie: current.header(),
      headers: { 'Content-Type': 'application/json' },
      form: JSON.stringify({ csrfToken, data: { user: { id: randomUUID() }, authSessionId: randomUUID() } }),
    });
    const latest = Math.floor(Date.now() / 1000);
    current.remember(result);
    expect(result.status).toBe(200);
    expect((JSON.parse(result.body) as { user: { id: string } }).user.id).toBe(ownerId);
    const claims = (await current.claims()) as { sub: string; authSessionId: string; exp: number };
    expect(claims.sub).toBe(ownerId);
    expect(claims.authSessionId).toBe(sessionId);
    expect(claims.exp).toBeGreaterThanOrEqual(earliest + thirtyDays);
    expect(claims.exp).toBeLessThanOrEqual(latest + thirtyDays);
    const encoded = (await snapshot()).encodes.slice(before.encodes.length);
    expect(encoded).toHaveLength(1);
    expect(encoded[0].tokenDigest).toBe(digest(current.session()));
  });

  it('both readers receive the exact reassembled JWE rather than any individual cookie chunk', async () => {
    const original = await parent('C'.repeat(4500));
    const chunks = [original.slice(0, 3000), original.slice(3000)];
    const header = chunks.map((content, index) => `${cookieName}.${index}=${content}`).join('; ');
    const before = await snapshot();
    for (const path of ['/__proof/server-session', '/api/auth/session']) {
      const result = await ownedHarness().request(path, { cookie: header });
      expect(result.status).toBe(200);
      expect((JSON.parse(result.body) as { user: { id: string } }).user.id).toBe(ownerId);
    }
    const decodes = (await snapshot()).decodes.slice(before.decodes.length);
    expect(decodes).toHaveLength(2);
    expect(decodes.every((entry) => entry.tokenDigest === digest(original) && entry.userId === ownerId)).toBe(true);
    expect(decodes.some((entry) => chunks.some((chunk) => entry.tokenDigest === digest(chunk)))).toBe(false);
  });

  it('an invalid server-read cookie becomes null without publishing the stock cleanup', async () => {
    const before = await snapshot();
    const result = await ownedHarness().request('/__proof/server-session', {
      cookie: `${cookieName}=invalid-owned-jwe`,
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toBeNull();
    expect(result.cookies.length).toBe(0);
    const after = await snapshot();
    expect(after.encodes.length).toBe(before.encodes.length);
    expect(after.decodes.slice(before.decodes.length)).toEqual([
      expect.objectContaining({ tokenDigest: digest('invalid-owned-jwe'), failed: true }),
    ]);
  });

  it('the public session route denies an invalid cookie without publishing a cleanup', async () => {
    const before = await snapshot();
    const result = await ownedHarness().request('/api/auth/session', { cookie: `${cookieName}=invalid-owned-jwe` });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({});
    expect(result.cookies).toEqual([]);
    expect((await snapshot()).encodes.length).toBe(before.encodes.length);
  });

  it('uses actual primary admission while the readonly role denies activity writes', async () => {
    const current = browser(await parent());
    const before = await db.select().from(users);
    const response = await current.request('/api/auth/session');
    expect(response.status).toBe(200);
    expect((JSON.parse(response.body) as { user: { id: string } }).user.id).toBe(ownerId);
    await vi.waitFor(async () => {
      const observed = (await ownedHarness().call('snapshot')) as {
        admission: { statuses: number[]; activityPermissionDeniedLogs: number; activityOtherFailure: number };
      };
      expect(observed.admission.statuses).toContain(200);
      expect(observed.admission.activityPermissionDeniedLogs).toBeGreaterThan(0);
      expect(observed.admission.activityOtherFailure).toBe(0);
    });
    expect(await db.select().from(users)).toEqual(before);
  });

  it('keeps the current cookie and auth rows when real cutoff SELECT permission is denied', async () => {
    const current = browser(await parent());
    const originalCookie = current.header();
    const before = await Promise.all([
      db.select().from(users),
      db.select().from(userProfiles),
      db.select().from(userCredentials),
      db.select().from(authSubjectCutoffs),
    ]);
    await admin(sql`REVOKE SELECT ON TABLE ${authSubjectCutoffs} FROM ${sql.identifier(role)}`);
    try {
      const response = await current.request('/api/auth/session');
      expect(response.status).toBe(503);
      expect(response.cookies).toEqual([]);
      expect(current.header()).toBe(originalCookie);
      expect(JSON.parse(response.body)).toEqual({ error: 'Credential authority is temporarily unavailable' });
      const observed = (await ownedHarness().call('snapshot')) as {
        admission: { statuses: number[]; unavailableResponses: number };
      };
      expect(observed.admission.statuses.at(-1)).toBe(503);
      expect(observed.admission.unavailableResponses).toBeGreaterThan(0);
      expect(
        await Promise.all([
          db.select().from(users),
          db.select().from(userProfiles),
          db.select().from(userCredentials),
          db.select().from(authSubjectCutoffs),
        ]),
      ).toEqual(before);
    } finally {
      await admin(sql`GRANT SELECT ON TABLE ${authSubjectCutoffs} TO ${sql.identifier(role)}`);
    }
    expect((await current.request('/api/auth/session')).status).toBe(200);
  });
});

it('observation cannot turn a successful expired-token encoding into an encode failure', async () => {
  const webRequire = createRequire(new URL('../../../../../web/package.json', import.meta.url));
  const publicJwt = webRequire('next-auth/jwt') as typeof PublicJwt;
  const options: NextAuthOptions = { providers: [] };
  const observer = observeSessionPublication(options, publicJwt);
  const secret = randomBytes(32).toString('base64url');
  const rawToken = await options.jwt!.encode!({ token: { sub: ownerId }, secret, maxAge: -60 });
  expect(typeof rawToken).toBe('string');
  await expect(publicJwt.decode({ token: rawToken, secret })).rejects.toThrow();
  expect(observer.snapshot().encodes).toEqual([
    expect.objectContaining({ tokenDigest: digest(rawToken), observationFailed: true }),
  ]);
});

it('observes salted public encoding without changing the real key derivation', async () => {
  const webRequire = createRequire(new URL('../../../../../web/package.json', import.meta.url));
  const publicJwt = webRequire('next-auth/jwt') as typeof PublicJwt;
  const options: NextAuthOptions = { providers: [] };
  const observer = observeSessionPublication(options, publicJwt);
  const secret = randomBytes(32).toString('base64url');
  const salt = randomUUID();
  const rawToken = await options.jwt!.encode!({ token: { sub: ownerId }, secret, salt });
  const claims = await publicJwt.decode({ token: rawToken, secret, salt });
  expect(claims?.sub).toBe(ownerId);
  await expect(publicJwt.decode({ token: rawToken, secret })).rejects.toThrow();
  expect(observer.snapshot().encodes).toEqual([
    expect.objectContaining({ tokenDigest: digest(rawToken), userId: ownerId, observationFailed: false }),
  ]);
});
