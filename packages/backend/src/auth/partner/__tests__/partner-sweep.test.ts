import { createHash, randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  oauthAccessToken,
  oauthConnections,
  oauthConsentInteractions,
  oauthGrants,
  oauthRefreshAncestors,
  oauthRefreshToken,
  oauthSession,
  oauthVerification,
  userCredentials,
  users,
} from '@boardsesh/db/schema/auth';
import { db } from '../../../db/client';
import {
  PARTNER_SWEEP_GRACE_MS,
  PARTNER_SWEEP_LIMITS,
  sweepPartnerOAuth,
  type PartnerSweepDatabase,
  type PartnerSweepResult,
} from '../retention';
import { createPartnerTestEnvironment, type PartnerTestEnvironment } from './partner-fixture';
import { createApp, createUser, PASSWORD_HASH } from './revocation-fixtures';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Better Auth stores tokens as an unpadded base64url SHA-256. */
function storedHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

const at = (base: number, offsetMs: number) => new Date(base + offsetMs);

/** Runs `acquire` in a transaction on its own connection and resolves once its locks are held. */
async function holdLock(acquire: (transaction: typeof db) => Promise<unknown>): Promise<() => Promise<void>> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lockHeld!: () => void;
  let failed!: (error: unknown) => void;
  const held = new Promise<void>((resolve, reject) => {
    lockHeld = resolve;
    failed = reject;
  });
  const finished = db
    .transaction(async (transaction) => {
      await acquire(transaction as unknown as typeof db);
      lockHeld();
      await released;
    })
    .catch((error: unknown) => {
      failed(error);
      throw error;
    });
  await held;
  return async () => {
    release();
    await finished;
  };
}

interface Connection {
  climberId: string;
  clientId: string;
  connectionId: string;
}

async function seedConnection(
  overrides: { generation?: number; revokedAt?: Date; withPassword?: boolean } = {},
): Promise<Connection> {
  const developerId = await createUser('sweep-developer');
  const clientId = await createApp(developerId);
  const climberId = await createUser('sweep-climber');
  // Before the connection: a first password write would otherwise end it at once.
  if (overrides.withPassword)
    await db.insert(userCredentials).values({ userId: climberId, passwordHash: PASSWORD_HASH });
  const connectionId = randomUUID();
  await db.insert(oauthConnections).values({
    id: connectionId,
    userId: climberId,
    clientId,
    connectedAt: new Date(),
    generation: overrides.generation ?? 0,
    revokedAt: overrides.revokedAt,
  });
  return { climberId, clientId, connectionId };
}

/** A grant whose `created_at` is far enough back for any cutoff these tests use. */
async function insertGrant(connection: Connection, generation = 0): Promise<string> {
  const authorizationCodeId = `code-${randomUUID()}`;
  await db.insert(oauthGrants).values({
    authorizationCodeId,
    connectionId: connection.connectionId,
    generation,
    createdAt: new Date(Date.now() - 400 * DAY_MS),
  });
  return authorizationCodeId;
}

async function insertCode(authorizationCodeId: string, expiresAt: Date): Promise<string> {
  const id = randomUUID();
  await db.insert(oauthVerification).values({
    id,
    identifier: authorizationCodeId,
    value: JSON.stringify({ type: 'authorization_code' }),
    expiresAt,
  });
  return id;
}

async function insertRefresh(
  connection: Connection,
  authorizationCodeId: string,
  { expiresAt, revoked, sessionId }: { expiresAt: Date; revoked?: Date; sessionId?: string },
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const token = `refresh-hash-${randomUUID()}`;
  await db.insert(oauthRefreshToken).values({
    id,
    token,
    clientId: connection.clientId,
    userId: connection.climberId,
    authorizationCodeId,
    sessionId,
    expiresAt,
    revoked,
    createdAt: new Date(expiresAt.getTime() - 90 * DAY_MS),
    scopes: ['profile:read', 'offline_access'],
  });
  return { id, token };
}

async function insertAccess(
  connection: Connection,
  authorizationCodeId: string,
  { expiresAt, refreshId, sessionId }: { expiresAt: Date; refreshId?: string; sessionId?: string },
): Promise<string> {
  const id = randomUUID();
  await db.insert(oauthAccessToken).values({
    id,
    token: `access-hash-${randomUUID()}`,
    clientId: connection.clientId,
    userId: connection.climberId,
    authorizationCodeId,
    refreshId,
    sessionId,
    expiresAt,
    createdAt: new Date(expiresAt.getTime() - HOUR_MS),
    scopes: ['profile:read'],
  });
  return id;
}

async function insertAncestor(
  connection: Connection,
  authorizationCodeId: string,
  { token, expiresAt, consumedAt }: { token: string; expiresAt: Date; consumedAt?: Date },
): Promise<void> {
  await db.insert(oauthRefreshAncestors).values({
    tokenHash: token,
    clientId: connection.clientId,
    userId: connection.climberId,
    authorizationCodeId,
    expiresAt,
    consumedAt,
  });
}

async function insertSession(climberId: string, expiresAt: Date): Promise<string> {
  const id = randomUUID();
  await db.insert(oauthSession).values({
    id,
    token: `session-${randomUUID()}`,
    userId: climberId,
    expiresAt,
    updatedAt: new Date(),
  });
  return id;
}

async function insertInteraction(connection: Connection, expiresAt: Date): Promise<string> {
  const digest = `digest-${randomUUID()}`;
  await db.insert(oauthConsentInteractions).values({
    digest,
    userId: connection.climberId,
    authSessionId: randomUUID(),
    clientId: connection.clientId,
    connectionGeneration: 0,
    expiresAt,
  });
  return digest;
}

/** Every row of one family, by table. */
async function familyRows(authorizationCodeId: string) {
  return {
    grants: await db.$count(oauthGrants, eq(oauthGrants.authorizationCodeId, authorizationCodeId)),
    codes: await db.$count(oauthVerification, eq(oauthVerification.identifier, authorizationCodeId)),
    refreshTokens: await db.$count(oauthRefreshToken, eq(oauthRefreshToken.authorizationCodeId, authorizationCodeId)),
    accessTokens: await db.$count(oauthAccessToken, eq(oauthAccessToken.authorizationCodeId, authorizationCodeId)),
    ancestors: await db.$count(
      oauthRefreshAncestors,
      eq(oauthRefreshAncestors.authorizationCodeId, authorizationCodeId),
    ),
  };
}

const NO_FAMILY_ROWS = { grants: 0, codes: 0, refreshTokens: 0, accessTokens: 0, ancestors: 0 };

const sweepAt = (now: Date, limits = PARTNER_SWEEP_LIMITS): Promise<PartnerSweepResult> =>
  sweepPartnerOAuth(db, { now, limits });

/** Runs sweeps until one deletes nothing, so a test's rows are gone whatever else the database holds. */
async function sweepUntilDone(now: Date): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await sweepAt(now);
    expect(result.busySteps).toEqual([]);
    if (result.complete && Object.values(result.counts).every((count) => count === 0)) return;
  }
  throw new Error('The sweep kept finding rows to delete.');
}

/**
 * A live family as months of hourly rotation leave it: its first refresh token
 * rotated and long expired, its access tokens expired, its current refresh token
 * live, and an ancestor for every refresh token it ever had.
 */
async function seedLiveFamilyWithHistory(connection: Connection, base: number) {
  const authorizationCodeId = await insertGrant(connection);
  const rotated: { id: string; token: string }[] = [];
  const expiredAccess: string[] = [];
  for (let day = 0; day < 4; day += 1) {
    // Issued 120 days ago and on, rotated a day later: expired and spent.
    const issued = base - (120 - day) * DAY_MS;
    const refresh = await insertRefresh(connection, authorizationCodeId, {
      expiresAt: at(issued, 90 * DAY_MS),
      revoked: at(issued, DAY_MS),
    });
    await insertAncestor(connection, authorizationCodeId, {
      token: refresh.token,
      expiresAt: at(issued, 90 * DAY_MS),
      consumedAt: at(issued, DAY_MS),
    });
    rotated.push(refresh);
    expiredAccess.push(
      await insertAccess(connection, authorizationCodeId, { expiresAt: at(issued, HOUR_MS), refreshId: refresh.id }),
    );
  }
  const current = await insertRefresh(connection, authorizationCodeId, { expiresAt: at(base, 89 * DAY_MS) });
  await insertAncestor(connection, authorizationCodeId, { token: current.token, expiresAt: at(base, 89 * DAY_MS) });
  return { authorizationCodeId, rotated, expiredAccess, current };
}

describe('partner OAuth retention sweep', () => {
  let environment: PartnerTestEnvironment;

  beforeAll(async () => {
    environment = await createPartnerTestEnvironment();
    // Codes have no user column, so earlier files' codes outlive the users TRUNCATE.
    await db.delete(oauthVerification);
  });

  afterAll(async () => {
    await environment?.close();
  });

  it('on empty tables deletes nothing and finishes', async () => {
    await sweepUntilDone(new Date(Date.now() + 400 * DAY_MS));
    const result = await sweepAt(new Date(Date.now() + 400 * DAY_MS));
    expect(result).toEqual({
      counts: {
        sessions: 0,
        sessionAccessTokens: 0,
        expiredAccessTokens: 0,
        rotatedRefreshTokens: 0,
        families: 0,
        familyAccessTokens: 0,
        familyRefreshTokens: 0,
        familyAncestors: 0,
        familyCodes: 0,
        expiredCodes: 0,
        expiredInteractions: 0,
      },
      busySteps: [],
      complete: true,
    });
  });

  describe('sessions go with their tokens (F7 review)', () => {
    it('an expired session goes with the access token bound to it, which never reads active again', async () => {
      const client = await environment.createClient();
      // Without offline_access the token stays bound to the browser session.
      const issued = await environment.issueTokens(client, ['profile:read']);
      const [bound] = await db
        .select()
        .from(oauthAccessToken)
        .where(eq(oauthAccessToken.token, storedHash(issued.access_token)));
      expect(bound.sessionId).toBe(client.owner.sessionId);
      await db
        .update(oauthSession)
        .set({ expiresAt: new Date(Date.now() - 2 * HOUR_MS) })
        .where(eq(oauthSession.id, client.owner.sessionId));
      expect((await environment.introspect(client, issued.access_token)).body.active).toBe(false);

      await sweepAt(new Date());

      expect(await db.$count(oauthSession, eq(oauthSession.id, client.owner.sessionId))).toBe(0);
      expect(await db.$count(oauthAccessToken, eq(oauthAccessToken.id, bound.id))).toBe(0);
      expect((await environment.introspect(client, issued.access_token)).body.active).not.toBe(true);
    });

    it('is why: a session deleted on its own turns its bound token back on until it expires', async () => {
      const client = await environment.createClient();
      const issued = await environment.issueTokens(client, ['profile:read']);
      await db
        .update(oauthSession)
        .set({ expiresAt: new Date(Date.now() - 2 * HOUR_MS) })
        .where(eq(oauthSession.id, client.owner.sessionId));
      expect((await environment.introspect(client, issued.access_token)).body.active).toBe(false);
      await db.delete(oauthSession).where(eq(oauthSession.id, client.owner.sessionId));
      expect((await environment.introspect(client, issued.access_token)).body.active).toBe(true);
    });

    it('leaves an offline grant working after its session goes', async () => {
      const client = await environment.createClient();
      const offline = await environment.issueTokens(client);
      await db
        .update(oauthSession)
        .set({ expiresAt: new Date(Date.now() - 2 * HOUR_MS) })
        .where(eq(oauthSession.id, client.owner.sessionId));
      await sweepAt(new Date());
      expect(await db.$count(oauthSession, eq(oauthSession.id, client.owner.sessionId))).toBe(0);
      expect((await environment.introspect(client, offline.access_token)).body.active).toBe(true);
      expect((await environment.refresh(client, offline.refresh_token!)).response.status).toBe(200);
    });

    it('keeps a session whose bound token another transaction holds, and does not wait for it', async () => {
      const connection = await seedConnection();
      const authorizationCodeId = await insertGrant(connection);
      const base = Date.now();
      const sessionId = await insertSession(connection.climberId, at(base, -2 * HOUR_MS));
      const tokenId = await insertAccess(connection, authorizationCodeId, { expiresAt: at(base, HOUR_MS), sessionId });
      const release = await holdLock((transaction) =>
        transaction.select().from(oauthAccessToken).where(eq(oauthAccessToken.id, tokenId)).for('update'),
      );
      try {
        const result = await sweepAt(new Date(base));
        expect(result.busySteps).toEqual([]);
        expect(await db.$count(oauthSession, eq(oauthSession.id, sessionId))).toBe(1);
        expect(await db.$count(oauthAccessToken, eq(oauthAccessToken.id, tokenId))).toBe(1);
      } finally {
        await release();
      }
      await sweepAt(new Date(base));
      expect(await db.$count(oauthSession, eq(oauthSession.id, sessionId))).toBe(0);
      expect(await db.$count(oauthAccessToken, eq(oauthAccessToken.id, tokenId))).toBe(0);
    });

    it('leaves alone a session a refresh token is still bound to, which deleting it would only detach', async () => {
      const connection = await seedConnection();
      const authorizationCodeId = await insertGrant(connection);
      const base = Date.now();
      const sessionId = await insertSession(connection.climberId, at(base, -2 * HOUR_MS));
      const refresh = await insertRefresh(connection, authorizationCodeId, {
        expiresAt: at(base, 80 * DAY_MS),
        sessionId,
      });
      await sweepAt(new Date(base));
      expect(await db.$count(oauthSession, eq(oauthSession.id, sessionId))).toBe(1);
      const [kept] = await db.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.id, refresh.id));
      expect(kept.sessionId).toBe(sessionId);
    });
  });

  describe('codes go once expired (F8 review)', () => {
    it('a code nobody redeemed keeps its rows until an hour past expiry, then goes with its grant', async () => {
      const client = await environment.createClient();
      const authorization = await environment.authorize(client);
      const authorizationCodeId = storedHash(new URL(authorization.location!).searchParams.get('code')!);
      expect(await familyRows(authorizationCodeId)).toEqual({ ...NO_FAMILY_ROWS, grants: 1, codes: 1 });

      // The fence cut the code to 60 s; half an hour on it is expired but in its grace.
      await sweepAt(new Date(Date.now() + 30 * MINUTE_MS));
      expect(await familyRows(authorizationCodeId)).toEqual({ ...NO_FAMILY_ROWS, grants: 1, codes: 1 });

      await sweepAt(new Date(Date.now() + 2 * HOUR_MS));
      expect(await familyRows(authorizationCodeId)).toEqual(NO_FAMILY_ROWS);
      const exchanged = await environment.exchange(client, authorization);
      expect(exchanged.body.error).toBe('invalid_grant');
    });

    it("a deleted account's code goes too, though no grant reaches it any more", async () => {
      const client = await environment.createClient();
      const climber = await environment.createClimber();
      const authorization = await environment.authorize(client, { climber });
      const authorizationCodeId = storedHash(new URL(authorization.location!).searchParams.get('code')!);
      const [pending] = await db
        .select({ value: oauthVerification.value })
        .from(oauthVerification)
        .where(eq(oauthVerification.identifier, authorizationCodeId));
      // What the row keeps about the climber.
      expect(JSON.parse(pending.value)).toMatchObject({ userId: climber.userId, sessionId: climber.sessionId });

      await db.delete(users).where(eq(users.id, climber.userId));
      expect(await familyRows(authorizationCodeId)).toEqual({ ...NO_FAMILY_ROWS, codes: 1 });

      await sweepAt(new Date(Date.now() + 2 * HOUR_MS));
      expect(await familyRows(authorizationCodeId)).toEqual(NO_FAMILY_ROWS);
    });

    it('expired consent screens go, live ones stay', async () => {
      const connection = await seedConnection();
      const base = Date.now();
      const expired = await insertInteraction(connection, at(base, -2 * HOUR_MS));
      const inGrace = await insertInteraction(connection, at(base, -30 * MINUTE_MS));
      const live = await insertInteraction(connection, at(base, 10 * MINUTE_MS));
      await sweepAt(new Date(base));
      const left = await db
        .select({ digest: oauthConsentInteractions.digest })
        .from(oauthConsentInteractions)
        .where(inArray(oauthConsentInteractions.digest, [expired, inGrace, live]));
      expect(left.map(({ digest }) => digest).sort()).toEqual([inGrace, live].sort());
    });
  });

  describe('ancestry goes with its family, never before (F9 review)', () => {
    it('after 91 days a rotated grant keeps working and its first ancestor still trips reuse, with a sweep at day 91', async () => {
      const client = await environment.createClient();
      const firstGrant = await environment.issueTokens(client);
      const independentGrant = await environment.issueTokens(client);
      const firstAncestor = storedHash(firstGrant.refresh_token!);
      const originalTime = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(originalTime + 30 * DAY_MS);
        const day30 = await environment.refresh(client, firstGrant.refresh_token!, environment.instance);
        const independentDay30 = await environment.refresh(client, independentGrant.refresh_token!);
        expect(day30.response.status).toBe(200);
        vi.setSystemTime(originalTime + 91 * DAY_MS);
        const day91 = await environment.refresh(client, day30.body.refresh_token!);
        const independentDay91 = await environment.refresh(client, independentDay30.body.refresh_token!);
        expect(day91.response.status).toBe(200);

        // Every token from day 0 and day 30 is expired or rotated by now.
        const swept = await sweepPartnerOAuth(db);
        expect(swept.busySteps).toEqual([]);
        // The day-0 refresh row was rotated on day 30, so it is gone ...
        expect(await db.$count(oauthRefreshToken, eq(oauthRefreshToken.token, firstAncestor))).toBe(0);
        // ... but its ancestor, expired since day 90, is kept: the family is live.
        const [ancestor] = await db
          .select()
          .from(oauthRefreshAncestors)
          .where(eq(oauthRefreshAncestors.tokenHash, firstAncestor));
        expect(ancestor.consumedAt).not.toBeNull();
        expect(ancestor.expiresAt.getTime()).toBeLessThan(Date.now());
        expect((await environment.introspect(client, day91.body.access_token!)).body.active).toBe(true);

        const replay = await environment.refresh(client, firstGrant.refresh_token!);
        expect(replay.body.error).toBe('invalid_grant');
        expect((await environment.introspect(client, day91.body.access_token!)).body.active).toBe(false);
        expect((await environment.refresh(client, day91.body.refresh_token!)).body.error).toBe('invalid_grant');
        expect((await environment.introspect(client, independentDay91.body.access_token!)).body.active).toBe(true);
        expect((await environment.refresh(client, independentDay91.body.refresh_token!)).response.status).toBe(200);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a live family keeps its current token, its grant and every ancestor, however old', async () => {
      const connection = await seedConnection();
      const base = Date.now();
      const family = await seedLiveFamilyWithHistory(connection, base);
      await sweepAt(new Date(base));
      expect(await familyRows(family.authorizationCodeId)).toEqual({
        grants: 1,
        codes: 0,
        // The current token. Its rotated predecessors are gone, their ancestors kept.
        refreshTokens: 1,
        accessTokens: 0,
        ancestors: 5,
      });
      expect(await db.$count(oauthRefreshToken, eq(oauthRefreshToken.id, family.current.id))).toBe(1);
    });

    it('keeps a rotated refresh row whose ancestor does not record the rotation', async () => {
      const connection = await seedConnection();
      const base = Date.now();
      const authorizationCodeId = await insertGrant(connection);
      const unrecorded = await insertRefresh(connection, authorizationCodeId, {
        expiresAt: at(base, 30 * DAY_MS),
        revoked: at(base, -2 * DAY_MS),
      });
      await insertAncestor(connection, authorizationCodeId, {
        token: unrecorded.token,
        expiresAt: at(base, 30 * DAY_MS),
      });
      const withoutAncestor = await insertRefresh(connection, authorizationCodeId, {
        expiresAt: at(base, 30 * DAY_MS),
        revoked: at(base, -2 * DAY_MS),
      });
      // The family is live, so the family step leaves both alone too.
      await insertRefresh(connection, authorizationCodeId, { expiresAt: at(base, 60 * DAY_MS) });
      await sweepAt(new Date(base));
      expect(
        await db.$count(oauthRefreshToken, inArray(oauthRefreshToken.id, [unrecorded.id, withoutAncestor.id])),
      ).toBe(2);
    });

    it('keeps a rotated refresh row until the access token issued with it has expired', async () => {
      const connection = await seedConnection();
      const base = Date.now();
      const authorizationCodeId = await insertGrant(connection);
      const rotated = await insertRefresh(connection, authorizationCodeId, {
        expiresAt: at(base, 89 * DAY_MS),
        revoked: at(base, -2 * HOUR_MS),
      });
      await insertAncestor(connection, authorizationCodeId, {
        token: rotated.token,
        expiresAt: at(base, 89 * DAY_MS),
        consumedAt: at(base, -2 * HOUR_MS),
      });
      const stillLive = await insertAccess(connection, authorizationCodeId, {
        expiresAt: at(base, 20 * MINUTE_MS),
        refreshId: rotated.id,
      });
      await insertRefresh(connection, authorizationCodeId, { expiresAt: at(base, 90 * DAY_MS) });
      await sweepAt(new Date(base));
      expect(await db.$count(oauthRefreshToken, eq(oauthRefreshToken.id, rotated.id))).toBe(1);
      expect(await db.$count(oauthAccessToken, eq(oauthAccessToken.id, stillLive))).toBe(1);
      await sweepAt(new Date(base + 2 * HOUR_MS));
      expect(await db.$count(oauthRefreshToken, eq(oauthRefreshToken.id, rotated.id))).toBe(0);
    });

    it('an ended family goes whole, and replaying its token then takes no lock', async () => {
      const client = await environment.createClient();
      const first = await environment.issueTokens(client);
      const rotated = await environment.refresh(client, first.refresh_token!, environment.instance);
      expect(rotated.response.status).toBe(200);
      const [{ authorizationCodeId }] = await db
        .select({ authorizationCodeId: oauthRefreshToken.authorizationCodeId })
        .from(oauthRefreshToken)
        .where(eq(oauthRefreshToken.token, storedHash(rotated.body.refresh_token!)));
      // 91 days on, unused: the current token expired a day ago.
      const later = new Date(Date.now() + 91 * DAY_MS);
      await sweepAt(later);
      expect(await familyRows(authorizationCodeId!)).toEqual(NO_FAMILY_ROWS);

      // Nothing left to find, so a replay is refused before the climber's row lock.
      const release = await holdLock((transaction) =>
        transaction.select().from(users).where(eq(users.id, client.owner.userId)).for('update'),
      );
      try {
        const replay = await environment.refresh(client, first.refresh_token!);
        expect(replay.body.error).toBe('invalid_grant');
      } finally {
        await release();
      }
    });

    it('a family its connection fenced off goes whole even with unexpired tokens', async () => {
      const base = Date.now();
      for (const fence of [{ revokedAt: new Date() }, { generation: 3 }]) {
        const connection = await seedConnection(fence);
        const authorizationCodeId = await insertGrant(connection, 0);
        const current = await insertRefresh(connection, authorizationCodeId, { expiresAt: at(base, 80 * DAY_MS) });
        await insertAncestor(connection, authorizationCodeId, {
          token: current.token,
          expiresAt: at(base, 80 * DAY_MS),
        });
        await insertAccess(connection, authorizationCodeId, { expiresAt: at(base, HOUR_MS), refreshId: current.id });
        await insertCode(authorizationCodeId, at(base, MINUTE_MS));
        await sweepAt(new Date(base));
        expect(await familyRows(authorizationCodeId)).toEqual(NO_FAMILY_ROWS);
        expect(await db.$count(oauthConnections, eq(oauthConnections.id, connection.connectionId))).toBe(1);
      }
    });

    it('keeps a family alive by its code alone, or by an access token alone', async () => {
      const base = Date.now();
      const connection = await seedConnection();
      // A code not yet redeemed, on a grant whose clock reads long ago.
      const pendingCode = await insertGrant(connection);
      await insertCode(pendingCode, at(base, MINUTE_MS));
      // A token issued without offline_access and not bound to a session.
      const accessOnly = await insertGrant(connection);
      await insertAccess(connection, accessOnly, { expiresAt: at(base, 30 * MINUTE_MS) });
      // A refresh token revoked on its own (RFC 7009) leaves the access token issued before it.
      const revokedRefresh = await insertGrant(connection);
      const revoked = await insertRefresh(connection, revokedRefresh, {
        expiresAt: at(base, 60 * DAY_MS),
        revoked: at(base, -10 * MINUTE_MS),
      });
      await insertAncestor(connection, revokedRefresh, { token: revoked.token, expiresAt: at(base, 60 * DAY_MS) });
      const earlier = await insertRefresh(connection, revokedRefresh, {
        expiresAt: at(base, 60 * DAY_MS),
        revoked: at(base, -20 * MINUTE_MS),
      });
      await insertAncestor(connection, revokedRefresh, {
        token: earlier.token,
        expiresAt: at(base, 60 * DAY_MS),
        consumedAt: at(base, -20 * MINUTE_MS),
      });
      await insertAccess(connection, revokedRefresh, { expiresAt: at(base, 40 * MINUTE_MS), refreshId: earlier.id });

      await sweepAt(new Date(base));
      expect(await familyRows(pendingCode)).toEqual({ ...NO_FAMILY_ROWS, grants: 1, codes: 1 });
      expect(await familyRows(accessOnly)).toEqual({ ...NO_FAMILY_ROWS, grants: 1, accessTokens: 1 });
      expect(await familyRows(revokedRefresh)).toEqual({
        ...NO_FAMILY_ROWS,
        grants: 1,
        refreshTokens: 2,
        accessTokens: 1,
        ancestors: 2,
      });

      // Two hours on, all three have ended.
      await sweepAt(new Date(base + 2 * HOUR_MS));
      for (const authorizationCodeId of [pendingCode, accessOnly, revokedRefresh]) {
        expect(await familyRows(authorizationCodeId)).toEqual(NO_FAMILY_ROWS);
      }
    });

    it('keeps a grant issued within the hour even with nothing under it yet', async () => {
      const connection = await seedConnection();
      const authorizationCodeId = `code-${randomUUID()}`;
      await db
        .insert(oauthGrants)
        .values({ authorizationCodeId, connectionId: connection.connectionId, generation: 0 });
      await sweepAt(new Date());
      expect(await familyRows(authorizationCodeId)).toEqual({ ...NO_FAMILY_ROWS, grants: 1 });
    });

    it('a family too big for one batch is finished by later batches, grant last', async () => {
      const base = Date.now();
      // Small batches would otherwise go on families earlier tests left.
      await sweepUntilDone(new Date(base));
      const connection = await seedConnection();
      const authorizationCodeId = await insertGrant(connection);
      for (let index = 0; index < 7; index += 1) {
        await insertAncestor(connection, authorizationCodeId, {
          token: `hash-${randomUUID()}`,
          expiresAt: at(base, -DAY_MS),
          consumedAt: at(base, -2 * DAY_MS),
        });
      }
      const small = { batchSize: 3, maxBatchesPerStep: 1, budgetMs: 30_000 };
      const first = await sweepAt(new Date(base), small);
      expect(first.complete).toBe(false);
      expect(await familyRows(authorizationCodeId)).toEqual({ ...NO_FAMILY_ROWS, grants: 1, ancestors: 4 });
      await sweepAt(new Date(base), small);
      await sweepAt(new Date(base), small);
      expect(await familyRows(authorizationCodeId)).toEqual(NO_FAMILY_ROWS);
    });
  });

  it('keeps everything until an hour past its expiry', async () => {
    const connection = await seedConnection();
    const base = Date.now();
    const authorizationCodeId = await insertGrant(connection);
    // The family's last token expired 59 minutes before the sweep.
    const lastToken = await insertRefresh(connection, authorizationCodeId, { expiresAt: at(base, -59 * MINUTE_MS) });
    await insertAncestor(connection, authorizationCodeId, {
      token: lastToken.token,
      expiresAt: at(base, -59 * MINUTE_MS),
    });
    const accessId = await insertAccess(connection, authorizationCodeId, { expiresAt: at(base, -59 * MINUTE_MS) });
    const sessionId = await insertSession(connection.climberId, at(base, -59 * MINUTE_MS));
    const codeId = await insertCode(`orphan-${randomUUID()}`, at(base, -59 * MINUTE_MS));
    await sweepAt(new Date(base));
    expect(await familyRows(authorizationCodeId)).toEqual({
      ...NO_FAMILY_ROWS,
      grants: 1,
      refreshTokens: 1,
      accessTokens: 1,
      ancestors: 1,
    });
    expect(await db.$count(oauthAccessToken, eq(oauthAccessToken.id, accessId))).toBe(1);
    expect(await db.$count(oauthSession, eq(oauthSession.id, sessionId))).toBe(1);
    expect(await db.$count(oauthVerification, eq(oauthVerification.id, codeId))).toBe(1);

    await sweepAt(new Date(base + 2 * MINUTE_MS));
    expect(await familyRows(authorizationCodeId)).toEqual(NO_FAMILY_ROWS);
    expect(await db.$count(oauthSession, eq(oauthSession.id, sessionId))).toBe(0);
    expect(await db.$count(oauthVerification, eq(oauthVerification.id, codeId))).toBe(0);
    expect(PARTNER_SWEEP_GRACE_MS).toBe(HOUR_MS);
  });

  it('stops at its batch cap, says so, and a later run finishes; a run after that deletes nothing', async () => {
    const base = Date.now();
    await sweepUntilDone(new Date(base));
    const codes: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      codes.push(await insertCode(`orphan-${randomUUID()}`, at(base, -2 * HOUR_MS)));
    }
    const small = { batchSize: 2, maxBatchesPerStep: 1, budgetMs: 30_000 };
    const first = await sweepAt(new Date(base), small);
    expect(first.counts.expiredCodes).toBe(2);
    expect(first.complete).toBe(false);
    expect(await db.$count(oauthVerification, inArray(oauthVerification.id, codes))).toBe(3);
    await sweepUntilDone(new Date(base));
    expect(await db.$count(oauthVerification, inArray(oauthVerification.id, codes))).toBe(0);
  });

  describe('beside other transactions', () => {
    it('two sweeps at once split the work, both finish and nothing is left', async () => {
      const base = Date.now();
      await sweepUntilDone(new Date(base));
      const families: string[] = [];
      const sessions: string[] = [];
      for (let index = 0; index < 6; index += 1) {
        const connection = await seedConnection();
        const authorizationCodeId = await insertGrant(connection);
        const ended = await insertRefresh(connection, authorizationCodeId, { expiresAt: at(base, -DAY_MS) });
        await insertAncestor(connection, authorizationCodeId, { token: ended.token, expiresAt: at(base, -DAY_MS) });
        await insertAccess(connection, authorizationCodeId, { expiresAt: at(base, -DAY_MS), refreshId: ended.id });
        families.push(authorizationCodeId);
        const sessionId = await insertSession(connection.climberId, at(base, -2 * HOUR_MS));
        await insertAccess(connection, await insertGrant(connection), { expiresAt: at(base, HOUR_MS), sessionId });
        sessions.push(sessionId);
        await insertCode(`orphan-${randomUUID()}`, at(base, -2 * HOUR_MS));
      }
      const small = { batchSize: 2, maxBatchesPerStep: 50, budgetMs: 30_000 };
      const [first, second] = await Promise.all([sweepAt(new Date(base), small), sweepAt(new Date(base), small)]);
      expect(first.busySteps).toEqual([]);
      expect(second.busySteps).toEqual([]);
      expect(first.counts.families + second.counts.families).toBeGreaterThanOrEqual(families.length);
      for (const authorizationCodeId of families) {
        expect(await familyRows(authorizationCodeId)).toEqual(NO_FAMILY_ROWS);
      }
      expect(await db.$count(oauthSession, inArray(oauthSession.id, sessions))).toBe(0);
      const again = await sweepAt(new Date(base));
      expect(Object.values(again.counts).every((count) => count === 0)).toBe(true);
    });

    it('skips every row a live flow holds, without waiting, and takes them on the next run', async () => {
      const base = Date.now();
      const connection = await seedConnection();
      const authorizationCodeId = await insertGrant(connection);
      const ended = await insertRefresh(connection, authorizationCodeId, { expiresAt: at(base, -DAY_MS) });
      await insertAncestor(connection, authorizationCodeId, { token: ended.token, expiresAt: at(base, -DAY_MS) });
      const sessionId = await insertSession(connection.climberId, at(base, -2 * HOUR_MS));
      const codeId = await insertCode(`orphan-${randomUUID()}`, at(base, -2 * HOUR_MS));
      const digest = await insertInteraction(connection, at(base, -2 * HOUR_MS));
      const expiredAccess = await insertAccess(connection, await insertGrant(connection), {
        expiresAt: at(base, -2 * HOUR_MS),
      });

      // What a refresh, Disconnect or the password trigger would hold mid-transaction.
      const release = await holdLock(async (transaction) => {
        await transaction.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.id, ended.id)).for('update');
        await transaction.select().from(oauthSession).where(eq(oauthSession.id, sessionId)).for('update');
        await transaction.select().from(oauthVerification).where(eq(oauthVerification.id, codeId)).for('update');
        await transaction
          .select()
          .from(oauthConsentInteractions)
          .where(eq(oauthConsentInteractions.digest, digest))
          .for('update');
        await transaction.select().from(oauthAccessToken).where(eq(oauthAccessToken.id, expiredAccess)).for('update');
      });
      try {
        const started = performance.now();
        const result = await sweepAt(new Date(base));
        expect(performance.now() - started).toBeLessThan(2_000);
        expect(result.busySteps).toEqual([]);
        // The held refresh token keeps the family's ancestry and grant too.
        expect(await familyRows(authorizationCodeId)).toEqual({
          ...NO_FAMILY_ROWS,
          grants: 1,
          refreshTokens: 1,
          ancestors: 1,
        });
        expect(await db.$count(oauthSession, eq(oauthSession.id, sessionId))).toBe(1);
        expect(await db.$count(oauthVerification, eq(oauthVerification.id, codeId))).toBe(1);
        expect(await db.$count(oauthConsentInteractions, eq(oauthConsentInteractions.digest, digest))).toBe(1);
        expect(await db.$count(oauthAccessToken, eq(oauthAccessToken.id, expiredAccess))).toBe(1);
      } finally {
        await release();
      }
      await sweepAt(new Date(base));
      expect(await familyRows(authorizationCodeId)).toEqual(NO_FAMILY_ROWS);
      expect(await db.$count(oauthSession, eq(oauthSession.id, sessionId))).toBe(0);
      expect(await db.$count(oauthVerification, eq(oauthVerification.id, codeId))).toBe(0);
      expect(await db.$count(oauthConsentInteractions, eq(oauthConsentInteractions.digest, digest))).toBe(0);
      expect(await db.$count(oauthAccessToken, eq(oauthAccessToken.id, expiredAccess))).toBe(0);
    });

    it('skips a held grant, family token, ancestor, family code or rotated row the same way', async () => {
      const base = Date.now();
      const connection = await seedConnection();
      const endedFamily = async () => {
        const authorizationCodeId = await insertGrant(connection);
        const refresh = await insertRefresh(connection, authorizationCodeId, {
          expiresAt: at(base, 20 * DAY_MS),
          revoked: at(base, -DAY_MS),
        });
        await insertAncestor(connection, authorizationCodeId, {
          token: refresh.token,
          expiresAt: at(base, 20 * DAY_MS),
        });
        return { authorizationCodeId, refresh };
      };
      // As Disconnect or the password trigger deleting it would hold it.
      const heldGrant = await endedFamily();
      // An access token still pointing at the family's refresh token: deleting that
      // refresh token would cascade onto the held row.
      const heldAccess = await endedFamily();
      const heldAccessId = await insertAccess(connection, heldAccess.authorizationCodeId, {
        expiresAt: at(base, -2 * HOUR_MS),
        refreshId: heldAccess.refresh.id,
      });
      const heldAncestor = await endedFamily();
      const heldCode = await endedFamily();
      const heldCodeId = await insertCode(heldCode.authorizationCodeId, at(base, -2 * HOUR_MS));
      // A live family's rotated row, recorded by its ancestor.
      const live = await seedLiveFamilyWithHistory(connection, base);

      const release = await holdLock(async (transaction) => {
        await transaction
          .select()
          .from(oauthGrants)
          .where(eq(oauthGrants.authorizationCodeId, heldGrant.authorizationCodeId))
          .for('update');
        await transaction.select().from(oauthAccessToken).where(eq(oauthAccessToken.id, heldAccessId)).for('update');
        await transaction
          .select()
          .from(oauthRefreshAncestors)
          .where(eq(oauthRefreshAncestors.tokenHash, heldAncestor.refresh.token))
          .for('update');
        await transaction.select().from(oauthVerification).where(eq(oauthVerification.id, heldCodeId)).for('update');
        await transaction
          .select()
          .from(oauthRefreshToken)
          .where(eq(oauthRefreshToken.id, live.rotated[0].id))
          .for('update');
      });
      try {
        const result = await sweepAt(new Date(base));
        expect(result.busySteps).toEqual([]);
        expect(await familyRows(heldGrant.authorizationCodeId)).toEqual({
          ...NO_FAMILY_ROWS,
          grants: 1,
          refreshTokens: 1,
          ancestors: 1,
        });
        // Its refresh token waits for the held access token. Its ancestry need not:
        // nothing in an ended family is left to rotate.
        expect(await familyRows(heldAccess.authorizationCodeId)).toEqual({
          ...NO_FAMILY_ROWS,
          grants: 1,
          refreshTokens: 1,
          accessTokens: 1,
        });
        expect(await familyRows(heldAncestor.authorizationCodeId)).toEqual({
          ...NO_FAMILY_ROWS,
          grants: 1,
          ancestors: 1,
        });
        expect(await familyRows(heldCode.authorizationCodeId)).toEqual({ ...NO_FAMILY_ROWS, grants: 1, codes: 1 });
        expect(await db.$count(oauthRefreshToken, eq(oauthRefreshToken.id, live.rotated[0].id))).toBe(1);
        expect(await db.$count(oauthRefreshToken, eq(oauthRefreshToken.id, live.rotated[1].id))).toBe(0);
      } finally {
        await release();
      }
      await sweepAt(new Date(base));
      for (const family of [heldGrant, heldAccess, heldAncestor, heldCode]) {
        expect(await familyRows(family.authorizationCodeId)).toEqual(NO_FAMILY_ROWS);
      }
      expect(await db.$count(oauthRefreshToken, eq(oauthRefreshToken.id, live.rotated[0].id))).toBe(0);
    });

    it('a table locked whole, as a migration would, ends only the steps that read it', async () => {
      const base = Date.now();
      const sessionId = await insertSession((await seedConnection()).climberId, at(base, -2 * HOUR_MS));
      const release = await holdLock((transaction) =>
        transaction.execute(sql`lock table oauth_verification in access exclusive mode`),
      );
      let result: PartnerSweepResult;
      try {
        result = await sweepAt(new Date(base));
      } finally {
        await release();
      }
      expect(result.busySteps).toEqual(['families', 'codes']);
      expect(await db.$count(oauthSession, eq(oauthSession.id, sessionId))).toBe(0);
    });

    it('sessions a refresh token is bound to never crowd out the rest', async () => {
      const base = Date.now();
      await sweepUntilDone(new Date(base));
      const connection = await seedConnection();
      const authorizationCodeId = await insertGrant(connection);
      for (let index = 0; index < 3; index += 1) {
        const boundSession = await insertSession(connection.climberId, at(base, -3 * HOUR_MS));
        await insertRefresh(connection, authorizationCodeId, {
          expiresAt: at(base, 80 * DAY_MS),
          sessionId: boundSession,
        });
      }
      const plain = await insertSession(connection.climberId, at(base, -2 * HOUR_MS));
      await sweepAt(new Date(base), { batchSize: 2, maxBatchesPerStep: 1, budgetMs: 30_000 });
      expect(await db.$count(oauthSession, eq(oauthSession.id, plain))).toBe(0);
    });

    it('a refresh mid-rotation on a family that looks ended keeps every ancestor', async () => {
      // A clock far ahead makes the family look ended to the sweep while a refresh
      // of it is in flight: the case the grace period exists for, forced.
      const base = Date.now();
      const connection = await seedConnection();
      const authorizationCodeId = await insertGrant(connection);
      const older = await insertRefresh(connection, authorizationCodeId, {
        expiresAt: at(base, 80 * DAY_MS),
        revoked: at(base, -DAY_MS),
      });
      await insertAncestor(connection, authorizationCodeId, {
        token: older.token,
        expiresAt: at(base, 80 * DAY_MS),
        consumedAt: at(base, -DAY_MS),
      });
      const current = await insertRefresh(connection, authorizationCodeId, { expiresAt: at(base, 85 * DAY_MS) });
      await insertAncestor(connection, authorizationCodeId, { token: current.token, expiresAt: at(base, 85 * DAY_MS) });

      const successorToken = `refresh-hash-${randomUUID()}`;
      const release = await holdLock(async (transaction) => {
        // The provider's rotation: consume the current token, then issue its successor.
        await transaction
          .update(oauthRefreshToken)
          .set({ revoked: new Date(base), rotatedAt: new Date(base) })
          .where(eq(oauthRefreshToken.id, current.id));
        await transaction.insert(oauthRefreshToken).values({
          id: randomUUID(),
          token: successorToken,
          clientId: connection.clientId,
          userId: connection.climberId,
          authorizationCodeId,
          expiresAt: at(base, 90 * DAY_MS),
          createdAt: new Date(base),
          scopes: ['profile:read', 'offline_access'],
        });
        await transaction.insert(oauthRefreshAncestors).values({
          tokenHash: successorToken,
          clientId: connection.clientId,
          userId: connection.climberId,
          authorizationCodeId,
          expiresAt: at(base, 90 * DAY_MS),
        });
      });
      try {
        const result = await sweepAt(new Date(base + 100 * DAY_MS));
        expect(result.busySteps).toEqual([]);
      } finally {
        await release();
      }
      const ancestors = await db
        .select({ tokenHash: oauthRefreshAncestors.tokenHash })
        .from(oauthRefreshAncestors)
        .where(eq(oauthRefreshAncestors.authorizationCodeId, authorizationCodeId));
      expect(ancestors.map(({ tokenHash }) => tokenHash).sort()).toEqual(
        [older.token, current.token, successorToken].sort(),
      );
      expect(await db.$count(oauthGrants, eq(oauthGrants.authorizationCodeId, authorizationCodeId))).toBe(1);
      expect(await db.$count(oauthRefreshToken, eq(oauthRefreshToken.token, successorToken))).toBe(1);
    });

    it('runs beside password writes that end the same climbers, with neither failing', async () => {
      const base = Date.now();
      for (let round = 0; round < 8; round += 1) {
        const connection = await seedConnection({ withPassword: true });
        const ended = await insertGrant(connection);
        const endedToken = await insertRefresh(connection, ended, { expiresAt: at(base, -DAY_MS) });
        await insertAncestor(connection, ended, { token: endedToken.token, expiresAt: at(base, -DAY_MS) });
        await insertAccess(connection, ended, { expiresAt: at(base, -DAY_MS), refreshId: endedToken.id });
        const live = await seedLiveFamilyWithHistory(connection, base);
        await insertSession(connection.climberId, at(base, -2 * HOUR_MS));
        await insertInteraction(connection, at(base, -2 * HOUR_MS));

        const [swept] = await Promise.all([
          sweepAt(new Date(base), { batchSize: 1, maxBatchesPerStep: 50, budgetMs: 30_000 }),
          db
            .update(userCredentials)
            .set({ passwordHash: `fixture-password-hash-${round}` })
            .where(eq(userCredentials.userId, connection.climberId)),
        ]);
        expect(swept.busySteps).toEqual([]);
        // The trigger ended everything; the sweep only ever took what it could lock.
        expect(await familyRows(ended)).toEqual(NO_FAMILY_ROWS);
        expect(await familyRows(live.authorizationCodeId)).toEqual(NO_FAMILY_ROWS);
        const [after] = await db
          .select()
          .from(oauthConnections)
          .where(eq(oauthConnections.id, connection.connectionId));
        expect(after.revokedAt).not.toBeNull();
      }
    });
  });

  it('takes no lock on users or on any connection', async () => {
    const base = Date.now();
    const connection = await seedConnection();
    const family = await seedLiveFamilyWithHistory(connection, base);
    const ended = await insertGrant(connection);
    await insertCode(ended, at(base, -2 * HOUR_MS));
    // Its ancestry is reached through the connection, which must be read, not locked.
    const endedToken = await insertRefresh(connection, ended, { expiresAt: at(base, -DAY_MS) });
    await insertAncestor(connection, ended, { token: endedToken.token, expiresAt: at(base, -DAY_MS) });
    await insertSession(connection.climberId, at(base, -2 * HOUR_MS));
    // Held exclusively, as account deletion and an issuer would hold them.
    const release = await holdLock(async (transaction) => {
      await transaction.select().from(users).where(eq(users.id, connection.climberId)).for('update');
      await transaction
        .select()
        .from(oauthConnections)
        .where(eq(oauthConnections.id, connection.connectionId))
        .for('update');
    });
    try {
      const result = await sweepAt(new Date(base));
      expect(result.busySteps).toEqual([]);
      expect(await familyRows(ended)).toEqual(NO_FAMILY_ROWS);
      expect(await familyRows(family.authorizationCodeId)).toMatchObject({ refreshTokens: 1, ancestors: 5 });
    } finally {
      await release();
    }
  });

  it('every batch runs with its own short limits', async () => {
    const seen: string[][] = [];
    const recording: PartnerSweepDatabase = {
      transaction: (work, config) =>
        db.transaction(async (transaction) => {
          const result = await work(transaction);
          const [limits] = await transaction.execute<{
            lock_timeout: string;
            statement_timeout: string;
            idle_timeout: string;
          }>(
            sql`select current_setting('lock_timeout') as lock_timeout,
                       current_setting('statement_timeout') as statement_timeout,
                       current_setting('idle_in_transaction_session_timeout') as idle_timeout`,
          );
          seen.push([limits.lock_timeout, limits.statement_timeout, limits.idle_timeout]);
          return result;
        }, config),
    };
    await sweepPartnerOAuth(recording, { now: new Date() });
    expect(seen.length).toBeGreaterThanOrEqual(6);
    for (const limits of seen) expect(limits).toEqual(['100ms', '250ms', '5s']);
    const [outside] = await db.execute<{ statement_timeout: string }>(
      sql`select current_setting('statement_timeout') as statement_timeout`,
    );
    expect(outside.statement_timeout).not.toBe('250ms');
  });
});
