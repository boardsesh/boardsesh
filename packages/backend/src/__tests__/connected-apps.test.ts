import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { graphql } from 'graphql';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  DISCONNECT_APP,
  GET_MY_CONNECTED_APPS,
  GET_PARTNER_APPS_ENABLED,
} from '@boardsesh/graphql/operations/connected-apps';
import type { ConnectedApps, ConnectionContext } from '@boardsesh/shared-schema';
import { oauthAppPolicy, oauthClient, oauthConnections, oauthConsent, users } from '@boardsesh/db/schema/auth';
import { db } from '../db/client';
import { schema } from '../graphql';
import { __resetConnectedAppsModeForTests } from '../graphql/resolvers/connected-apps/connected-apps';
import { redisClientManager } from '../redis/client';
import {
  attachPartnerState,
  countsOf,
  createApp,
  createUser,
  INTACT_COUNTS,
  readPartnerState,
  REVOKED_COUNTS,
  seedConnectedClimber,
  type PartnerRows,
} from '../auth/partner/__tests__/revocation-fixtures';

// Connected apps run in every mode, so they must never need Better Auth or the
// partner authority. Loading either here fails the file.
vi.mock('better-auth', () => {
  throw new Error('Connected apps loaded Better Auth');
});
vi.mock('../auth/partner/authority', () => {
  throw new Error('Connected apps loaded the partner authority');
});

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/**
 * What a Disconnect leaves: the password trigger's REVOKED_COUNTS, except the
 * climber's bridged sign-in session, which belongs to the climber and not to
 * one app (`DELETE /v1/connection` keeps it too). The sweep removes it on expiry.
 */
const DISCONNECTED_COUNTS = { ...REVOKED_COUNTS, sessions: INTACT_COUNTS.sessions };

interface Reply<Data> {
  data?: Data | null;
  errors?: ReadonlyArray<{ message: string; extensions?: Record<string, unknown> }>;
}

function contextFor(userId: string | null): ConnectionContext {
  return {
    connectionId: `http-${randomUUID()}`,
    transport: 'http',
    isAuthenticated: userId !== null,
    ...(userId ? { userId } : {}),
  } as ConnectionContext;
}

async function listAs(userId: string | null): Promise<Reply<{ myConnectedApps: ConnectedApps }>> {
  return (await graphql({
    schema,
    source: GET_MY_CONNECTED_APPS,
    contextValue: contextFor(userId),
  })) as Reply<{ myConnectedApps: ConnectedApps }>;
}

async function disconnectAs(userId: string | null, connectionId: string): Promise<Reply<{ disconnectApp: boolean }>> {
  return (await graphql({
    schema,
    source: DISCONNECT_APP,
    variableValues: { connectionId },
    contextValue: contextFor(userId),
  })) as Reply<{ disconnectApp: boolean }>;
}

async function appsOf(userId: string) {
  const reply = await listAs(userId);
  expect(reply.errors).toBeUndefined();
  return reply.data!.myConnectedApps;
}

async function setMode(mode: string | undefined): Promise<void> {
  if (mode === undefined) vi.stubEnv('PARTNER_OAUTH_MODE', '');
  else vi.stubEnv('PARTNER_OAUTH_MODE', mode);
  __resetConnectedAppsModeForTests();
}

async function nameApp(clientId: string, name: string | null): Promise<void> {
  await db.update(oauthClient).set({ name }).where(eq(oauthClient.clientId, clientId));
}

async function grantScopes(rows: PartnerRows, scopes: string[]): Promise<void> {
  await db.update(oauthConsent).set({ scopes }).where(eq(oauthConsent.userId, rows.climberId));
}

beforeAll(async () => {
  await redisClientManager.connect();
});

afterAll(async () => {
  await redisClientManager.disconnect();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetConnectedAppsModeForTests();
});

describe('myConnectedApps', () => {
  it("lists the climber's live connections, most recently connected first, in the wire shape", async () => {
    const older = await seedConnectedClimber('climber');
    await nameApp(older.clientId, '  Hangboard Planner  ');
    await grantScopes(older, ['profile:read', 'logbook:read', 'offline_access']);
    const connectedAt = new Date(Date.now() - 2 * DAY_MS);
    const lastUsedAt = new Date(Date.now() - 3 * HOUR_MS);
    await db
      .update(oauthConnections)
      .set({ connectedAt, lastUsedAt })
      .where(eq(oauthConnections.id, older.connectionId));

    const developerId = await createUser('developer');
    const newer = await attachPartnerState(older.climberId, await createApp(developerId));
    await nameApp(newer.clientId, 'DivePeaks');
    // The newer app's registration names its maker; the older one predates the column.
    await db
      .insert(oauthAppPolicy)
      .values({ clientId: newer.clientId, ownerUserId: developerId, publisherName: '  DivePeaks Labs  ' })
      .onConflictDoUpdate({ target: oauthAppPolicy.clientId, set: { publisherName: '  DivePeaks Labs  ' } });

    const listed = await appsOf(older.climberId);
    expect(listed.apps).toEqual([
      {
        connectionId: newer.connectionId,
        name: 'DivePeaks',
        publisherName: 'DivePeaks Labs',
        scopes: ['offline_access'],
        connectedAt: expect.any(String),
        lastUsedAt: null,
        suspended: false,
      },
      {
        connectionId: older.connectionId,
        name: 'Hangboard Planner',
        publisherName: null,
        scopes: ['profile:read', 'logbook:read', 'offline_access'],
        connectedAt: connectedAt.toISOString(),
        lastUsedAt: lastUsedAt.toISOString(),
        suspended: false,
      },
    ]);
  });

  it('reads an app with no name as null', async () => {
    const rows = await seedConnectedClimber();
    await nameApp(rows.clientId, '   ');
    expect((await appsOf(rows.climberId)).apps.map((app) => app.name)).toEqual([null]);
  });

  it('leaves out an approval the app never redeemed and a connection the climber ended', async () => {
    const pending = await seedConnectedClimber();
    await db.update(oauthConnections).set({ connectedAt: null }).where(eq(oauthConnections.id, pending.connectionId));
    const ended = await attachPartnerState(pending.climberId, await createApp(await createUser('developer')));
    await db
      .update(oauthConnections)
      .set({ revokedAt: new Date(), revocationReason: 'climber_disconnect' })
      .where(eq(oauthConnections.id, ended.connectionId));
    expect((await appsOf(pending.climberId)).apps).toEqual([]);
  });

  it("never shows another climber's connections", async () => {
    const mine = await seedConnectedClimber('mine');
    const theirs = await seedConnectedClimber('theirs');
    // The same app, connected by both.
    const sharedApp = await attachPartnerState(theirs.climberId, mine.clientId);
    expect((await appsOf(mine.climberId)).apps.map((app) => app.connectionId)).toEqual([mine.connectionId]);
    expect((await appsOf(theirs.climberId)).apps.map((app) => app.connectionId).sort()).toEqual(
      [theirs.connectionId, sharedApp.connectionId].sort(),
    );
  });

  it.each([
    ['the client is disabled', { disabled: true }, null],
    ['the policy is suspended', { disabled: false }, new Date()],
  ])('marks an app suspended when %s', async (_label, clientPatch, suspendedAt) => {
    const rows = await seedConnectedClimber();
    await db.update(oauthClient).set(clientPatch).where(eq(oauthClient.clientId, rows.clientId));
    await db.update(oauthAppPolicy).set({ suspendedAt }).where(eq(oauthAppPolicy.clientId, rows.clientId));
    expect((await appsOf(rows.climberId)).apps.map((app) => app.suspended)).toEqual([true]);
  });

  it('answers an empty list for a climber with no apps', async () => {
    const climberId = await createUser('climber');
    expect((await appsOf(climberId)).apps).toEqual([]);
  });

  it('refuses a signed-out caller', async () => {
    const reply = await listAs(null);
    expect(reply.data).toBeNull();
    expect(reply.errors?.[0]?.message).toMatch(/Authentication required/);
  });
});

describe('disconnectApp', () => {
  it('ends the connection the way DELETE /v1/connection does', async () => {
    const rows = await seedConnectedClimber();
    const reply = await disconnectAs(rows.climberId, rows.connectionId);
    expect(reply).toEqual({ data: { disconnectApp: true } });
    const state = await readPartnerState(rows);
    expect(countsOf(state)).toEqual(DISCONNECTED_COUNTS);
    expect(state.connection).toMatchObject({
      generation: 1,
      revocationReason: 'climber_disconnect',
      revokedAt: expect.any(Date),
    });
    expect((await appsOf(rows.climberId)).apps).toEqual([]);
  });

  it("refuses another climber's connection id and ends nothing", async () => {
    const victim = await seedConnectedClimber('victim');
    const attacker = await seedConnectedClimber('attacker');
    const reply = await disconnectAs(attacker.climberId, victim.connectionId);
    expect(reply.data).toBeNull();
    expect(reply.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
    const state = await readPartnerState(victim);
    expect(countsOf(state)).toEqual(INTACT_COUNTS);
    expect(state.connection).toMatchObject({ generation: 0, revokedAt: null });
    // The attacker's own connection is untouched too.
    expect(countsOf(await readPartnerState(attacker))).toEqual(INTACT_COUNTS);
  });

  it("refuses another climber's id for the same app, and ends neither connection", async () => {
    const victim = await seedConnectedClimber('victim');
    const attackerId = await createUser('attacker');
    const attacker = await attachPartnerState(attackerId, victim.clientId);
    const reply = await disconnectAs(attacker.climberId, victim.connectionId);
    expect(reply.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
    expect(countsOf(await readPartnerState(victim))).toEqual(INTACT_COUNTS);
    expect((await readPartnerState(attacker)).connection).toMatchObject({ generation: 0, revokedAt: null });
  });

  it('answers an unknown id the same way as a stranger', async () => {
    const rows = await seedConnectedClimber();
    const reply = await disconnectAs(rows.climberId, randomUUID());
    expect(reply.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
    expect(reply.errors?.[0]?.message).toBe('No such connected app.');
  });

  it.each([[''], ['x'.repeat(129)]])('refuses a malformed id %#', async (connectionId) => {
    const rows = await seedConnectedClimber();
    const reply = await disconnectAs(rows.climberId, connectionId);
    expect(reply.errors?.[0]?.extensions?.code).toBe('BAD_USER_INPUT');
    expect(countsOf(await readPartnerState(rows))).toEqual(INTACT_COUNTS);
  });

  it('is done when the connection already ended, without raising the generation again', async () => {
    const rows = await seedConnectedClimber();
    expect((await disconnectAs(rows.climberId, rows.connectionId)).data).toEqual({ disconnectApp: true });
    expect((await disconnectAs(rows.climberId, rows.connectionId)).data).toEqual({ disconnectApp: true });
    expect((await readPartnerState(rows)).connection).toMatchObject({ generation: 1 });
  });

  it('ends an approved reconnect the app has not redeemed yet', async () => {
    const rows = await seedConnectedClimber();
    await db.update(oauthConnections).set({ connectedAt: null }).where(eq(oauthConnections.id, rows.connectionId));
    expect((await disconnectAs(rows.climberId, rows.connectionId)).data).toEqual({ disconnectApp: true });
    expect(countsOf(await readPartnerState(rows))).toEqual(DISCONNECTED_COUNTS);
  });

  it('refuses a signed-out caller', async () => {
    const rows = await seedConnectedClimber();
    const reply = await disconnectAs(null, rows.connectionId);
    expect(reply.errors?.[0]?.message).toMatch(/Authentication required/);
    expect(countsOf(await readPartnerState(rows))).toEqual(INTACT_COUNTS);
  });

  it('answers busy, and changes nothing, while the climber row is locked past the 2 s lock wait', async () => {
    const rows = await seedConnectedClimber();
    // A password reset holds the row like this (FOR NO KEY UPDATE conflicts with FOR SHARE).
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      await holder.begin(async (transaction) => {
        await transaction`select id from users where id = ${rows.climberId} for no key update`;
        const startedAt = Date.now();
        const reply = await disconnectAs(rows.climberId, rows.connectionId);
        expect(Date.now() - startedAt).toBeLessThan(4_500);
        expect(reply.errors?.[0]?.extensions).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryAfterSeconds: 2 });
      });
    } finally {
      await holder.end();
    }
    expect(countsOf(await readPartnerState(rows))).toEqual(INTACT_COUNTS);
  });
});

describe('every PARTNER_OAUTH_MODE', () => {
  it.each([
    [undefined, false],
    ['off', false],
    ['hold', true],
    ['allowlist', true],
    ['open', true],
  ])('with the mode %j, lists and disconnects, and says whether apps are on (%s)', async (mode, enabled) => {
    await setMode(mode);
    const rows = await seedConnectedClimber();
    const listed = await appsOf(rows.climberId);
    expect(listed.partnerAppsEnabled).toBe(enabled);
    // The standalone read the draft and Spraywall notes use: the same answer, signed in or not.
    for (const userId of [rows.climberId, null]) {
      const reply = await graphql({ schema, source: GET_PARTNER_APPS_ENABLED, contextValue: contextFor(userId) });
      expect(reply).toEqual({ data: { partnerAppsEnabled: enabled } });
    }
    expect(listed.apps.map((app) => app.connectionId)).toEqual([rows.connectionId]);
    expect((await disconnectAs(rows.climberId, rows.connectionId)).data).toEqual({ disconnectApp: true });
    expect(countsOf(await readPartnerState(rows))).toEqual(DISCONNECTED_COUNTS);
  });
});

describe('a deleted climber', () => {
  it('has nothing to list once the account is gone', async () => {
    const rows = await seedConnectedClimber();
    await db.delete(users).where(eq(users.id, rows.climberId));
    expect((await appsOf(rows.climberId)).apps).toEqual([]);
  });
});
