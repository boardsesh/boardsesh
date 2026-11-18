import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { communityRoles, partnerAppCapAudit } from '@boardsesh/db/schema/app';
import { oauthAppPolicy, oauthClient, oauthConnections } from '@boardsesh/db/schema/auth';
import { db } from '../db/client';
import { createApp, createUser } from '../auth/partner/__tests__/revocation-fixtures';
import { createPartnerTestEnvironment, type PartnerTestEnvironment } from '../auth/partner/__tests__/partner-fixture';
import { checkConnectionCaps } from '../auth/partner/connection-caps';
import {
  adminPartnerAppMutations,
  adminPartnerAppQueries,
  AdminPartnerAppsInputSchema,
  UpdatePartnerAppLimitsInputSchema,
} from '../graphql/resolvers/oauth-clients/admin-partner-apps';

let admin: ConnectionContext;
let environment: PartnerTestEnvironment;

beforeAll(async () => {
  environment = await createPartnerTestEnvironment();
});
afterAll(async () => {
  await environment?.close();
});
beforeEach(async () => {
  const userId = await createUser('partner-global-admin');
  await db.insert(communityRoles).values({ userId, role: 'admin', boardType: null });
  admin = { userId, isAuthenticated: true, connectionId: randomUUID() } as ConnectionContext;
});

async function connection(clientId: string, connectedAt: Date | null, revokedAt: Date | null = null) {
  const id = randomUUID();
  await db
    .insert(oauthConnections)
    .values({ id, clientId, userId: await createUser('connected-climber'), connectedAt, revokedAt });
  return id;
}

async function directoryApp(label = 'directory') {
  const ownerId = await createUser('partner-developer');
  const clientId = await createApp(ownerId);
  const name = `${label}-${randomUUID()}`;
  await db
    .update(oauthClient)
    .set({ name, clientSecret: 'NEVER-RETURN-THIS-SECRET' })
    .where(eq(oauthClient.clientId, clientId));
  return { clientId, name, ownerId };
}

describe('global-admin partner app directory', () => {
  it('rejects signed-out visitors, ordinary accounts, and board-scoped admins on reads and writes', async () => {
    const userId = await createUser('scoped-admin');
    await db.insert(communityRoles).values({ userId, role: 'admin', boardType: 'kilter' });
    for (const context of [
      { isAuthenticated: false },
      { userId: await createUser('ordinary'), isAuthenticated: true },
      { userId, isAuthenticated: true },
    ]) {
      await expect(adminPartnerAppQueries.adminPartnerApps(null, {}, context as ConnectionContext)).rejects.toThrow();
      await expect(
        adminPartnerAppMutations.updatePartnerAppLimits(
          null,
          { input: { clientId: 'missing', maxActiveConnections: 1, maxNewConnectionsPerDay: 1 } },
          context as ConnectionContext,
        ),
      ).rejects.toThrow();
    }
  });

  it('counts redeemed connections without exposing credentials or climber identities', async () => {
    const app = await directoryApp();
    const now = new Date();
    await connection(app.clientId, now);
    await connection(app.clientId, new Date(now.getTime() - 25 * 60 * 60 * 1000));
    await connection(app.clientId, now, now);
    await connection(app.clientId, null);
    await connection(app.clientId, null, now);
    const result = await adminPartnerAppQueries.adminPartnerApps(null, { input: { query: app.name } }, admin);
    expect(result.totalCount).toBe(1);
    expect(result.apps).toHaveLength(1);
    expect(result.apps[0]).toMatchObject({
      clientId: app.clientId,
      activeConnections: 2,
      newConnectionsLast24Hours: 2,
      maxActiveConnections: 25,
      maxNewConnectionsPerDay: 20,
    });
    expect(result.apps[0]).not.toHaveProperty('clientSecret');
    expect(result.apps[0]).not.toHaveProperty('connections');
    expect(JSON.stringify(result)).not.toContain('NEVER-RETURN-THIS-SECRET');
  });

  it('searches by owner and publisher, paginates, and treats wildcard characters literally', async () => {
    const first = await directoryApp('literal_100%');
    const second = await directoryApp('literal_100%');
    const publisher = `Publisher ${randomUUID()}`;
    for (const clientId of [first.clientId, second.clientId]) {
      await db.update(oauthAppPolicy).set({ publisherName: publisher }).where(eq(oauthAppPolicy.clientId, clientId));
    }
    const page = await adminPartnerAppQueries.adminPartnerApps(null, { input: { query: publisher, limit: 1 } }, admin);
    expect(page.totalCount).toBe(2);
    expect(page.hasMore).toBe(true);
    const next = await adminPartnerAppQueries.adminPartnerApps(
      null,
      { input: { query: publisher, limit: 1, offset: 1 } },
      admin,
    );
    expect(next.hasMore).toBe(false);
    expect(next.apps[0].clientId).not.toBe(page.apps[0].clientId);
    const owner = await adminPartnerAppQueries.adminPartnerApps(
      null,
      { input: { query: `${first.ownerId}@example.invalid` } },
      admin,
    );
    expect(owner.apps.map((app) => app.clientId)).toEqual([first.clientId]);
    const literal = await adminPartnerAppQueries.adminPartnerApps(null, { input: { query: 'literal_100%' } }, admin);
    expect(literal.totalCount).toBe(2);
    const absent = await adminPartnerAppQueries.adminPartnerApps(null, { input: { query: '%' } }, admin);
    expect(absent.apps.every((app) => app.name?.includes('%'))).toBe(true);
  });

  it('validates both caps as PostgreSQL nonnegative integers and bounds page sizes', () => {
    for (const invalid of [-1, 1.5, 2_147_483_648, NaN, Infinity, '20', null]) {
      expect(
        UpdatePartnerAppLimitsInputSchema.safeParse({
          clientId: 'app',
          maxActiveConnections: invalid,
          maxNewConnectionsPerDay: 20,
        }).success,
      ).toBe(false);
      expect(
        UpdatePartnerAppLimitsInputSchema.safeParse({
          clientId: 'app',
          maxActiveConnections: 25,
          maxNewConnectionsPerDay: invalid,
        }).success,
      ).toBe(false);
    }
    expect(
      UpdatePartnerAppLimitsInputSchema.parse({
        clientId: 'app',
        maxActiveConnections: 0,
        maxNewConnectionsPerDay: 2_147_483_647,
      }),
    ).toBeTruthy();
    expect(AdminPartnerAppsInputSchema.parse({})).toMatchObject({ limit: 50, offset: 0 });
    expect(AdminPartnerAppsInputSchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe('audited partner app connection limits', () => {
  it('stores each actor and before/after pair under concurrent changes', async () => {
    const app = await directoryApp();
    await Promise.all(
      [10, 11].map((cap) =>
        adminPartnerAppMutations.updatePartnerAppLimits(
          null,
          {
            input: { clientId: app.clientId, maxActiveConnections: cap, maxNewConnectionsPerDay: cap },
          },
          admin,
        ),
      ),
    );
    const audits = await db.select().from(partnerAppCapAudit).where(eq(partnerAppCapAudit.clientId, app.clientId));
    expect(audits).toHaveLength(2);
    expect(audits.every((audit) => audit.performedBy === admin.userId)).toBe(true);
    const first = audits.find((audit) => audit.previousMaxActiveConnections === 25)!;
    const second = audits.find((audit) => audit.previousMaxActiveConnections === first.maxActiveConnections)!;
    expect(first.previousMaxNewConnectionsPerDay).toBe(20);
    expect(second.previousMaxNewConnectionsPerDay).toBe(first.maxNewConnectionsPerDay);
    const [policy] = await db.select().from(oauthAppPolicy).where(eq(oauthAppPolicy.clientId, app.clientId));
    expect(policy.maxActiveConnections).toBe(second.maxActiveConnections);
    expect(policy.maxNewConnectionsPerDay).toBe(second.maxNewConnectionsPerDay);
  });

  it('sets zero to block new connections while keeping issued credentials valid', async () => {
    const client = await environment.createClient();
    const issued = await environment.issueTokens(client);
    const updated = await adminPartnerAppMutations.updatePartnerAppLimits(
      null,
      { input: { clientId: client.clientId, maxActiveConnections: 0, maxNewConnectionsPerDay: 0 } },
      admin,
    );
    expect(updated.maxActiveConnections).toBe(0);
    expect((await environment.introspect(client, issued.access_token)).body.active).toBe(true);
    const candidate = await connection(client.clientId, null);
    expect(
      await environment.database.transaction((transaction) =>
        checkConnectionCaps(transaction, { id: candidate, clientId: client.clientId }, new Date()),
      ),
    ).toBe('active_connections');
    const [audit] = await db
      .select()
      .from(partnerAppCapAudit)
      .where(and(eq(partnerAppCapAudit.clientId, client.clientId), eq(partnerAppCapAudit.performedBy, admin.userId!)));
    expect(audit).toMatchObject({
      previousMaxActiveConnections: 25,
      previousMaxNewConnectionsPerDay: 20,
      maxActiveConnections: 0,
      maxNewConnectionsPerDay: 0,
    });
  });

  it('zero daily limit refuses new climbers independently of the active cap', async () => {
    const client = await environment.createClient();
    const candidate = await connection(client.clientId, null);
    await adminPartnerAppMutations.updatePartnerAppLimits(
      null,
      { input: { clientId: client.clientId, maxActiveConnections: 25, maxNewConnectionsPerDay: 0 } },
      admin,
    );
    expect(
      await environment.database.transaction((transaction) =>
        checkConnectionCaps(transaction, { id: candidate, clientId: client.clientId }, new Date()),
      ),
    ).toBe('new_connections_today');
  });

  it('reports a missing app without writing an audit row', async () => {
    const clientId = `missing-${randomUUID()}`;
    await expect(
      adminPartnerAppMutations.updatePartnerAppLimits(
        null,
        { input: { clientId, maxActiveConnections: 1, maxNewConnectionsPerDay: 1 } },
        admin,
      ),
    ).rejects.toThrow('App not found.');
    expect(await db.select().from(partnerAppCapAudit).where(eq(partnerAppCapAudit.clientId, clientId))).toEqual([]);
  });
});
