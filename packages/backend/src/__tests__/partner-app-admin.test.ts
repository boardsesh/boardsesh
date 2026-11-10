import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { executeFirstRow } from '@boardsesh/db/client';
import { oauthAppPolicy, oauthClient } from '@boardsesh/db/schema/auth';
import { db } from '../db/client';
import {
  parsePartnerAdminArguments,
  PartnerAdminUsageError,
  revokePartnerUser,
  setPartnerAppPublisher,
  suspendPartnerApp,
  unsuspendPartnerApp,
  type PartnerAdminDatabase,
} from '../scripts/partner-app-admin';
import { createPartnerTestEnvironment, type PartnerTestEnvironment } from '../auth/partner/__tests__/partner-fixture';
import {
  countsOf,
  createApp,
  createUser,
  INTACT_COUNTS,
  readPartnerState,
  REVOKED_COUNTS,
  seedConnectedClimber,
} from '../auth/partner/__tests__/revocation-fixtures';
import { getWorkerDatabaseUrl } from './worker-db';

describe('partner-app-admin arguments', () => {
  it.each([
    [
      ['suspend', '--client-id', 'abc', '--reason', 'Phishing reports'],
      { command: 'suspend', clientId: 'abc', reason: 'Phishing reports', apply: false },
    ],
    [
      ['suspend', '--reason', 'Spam', '--client-id', 'abc', '--apply'],
      { command: 'suspend', clientId: 'abc', reason: 'Spam', apply: true },
    ],
    [['unsuspend', '--client-id', 'abc'], { command: 'unsuspend', clientId: 'abc', apply: false }],
    [['revoke-user', '--user-id', 'user-1', '--apply'], { command: 'revoke-user', userId: 'user-1', apply: true }],
    [
      ['set-publisher', '--client-id', 'abc', '--publisher', '  Crimp   Labs '],
      { command: 'set-publisher', clientId: 'abc', publisherName: 'Crimp Labs', apply: false },
    ],
  ])('reads %j', (argv, expected) => {
    expect(parsePartnerAdminArguments(argv)).toEqual(expected);
  });

  it.each([
    [[], /Unknown command/],
    [['delete-app', '--client-id', 'abc'], /Unknown command/],
    [['suspend', '--client-id', 'abc'], /needs --reason/],
    [['suspend', '--reason', 'Spam'], /needs --client-id/],
    [['suspend', '--client-id', 'abc', '--reason', '   '], /--reason must be/],
    [['revoke-user'], /needs --user-id/],
    [['revoke-user', '--user-id'], /needs a value/],
    [['revoke-user', '--user-id', '--apply'], /needs a value/],
    [['revoke-user', '--user-id', 'a,b'], /exactly one id/],
    [['revoke-user', '--user-id', 'user 1'], /exactly one id/],
    [['revoke-user', '--user-id', '*'], /exactly one id/],
    [['revoke-user', '--user-id', '%'], /exactly one id/],
    [['revoke-user', '--user-id', 'a', '--user-id', 'b'], /given twice/],
    [['revoke-user', '--user-id', 'a', '--apply', '--apply'], /given twice/],
    [['revoke-user', '--client-id', 'abc'], /does not take --client-id/],
    [['unsuspend', '--client-id', 'abc', '--reason', 'x'], /does not take --reason/],
    [['set-publisher', '--client-id', 'abc'], /needs --publisher/],
    [['set-publisher', '--client-id', 'abc', '--publisher', 'Boardsesh Team'], /--publisher: .*imitate "Boardsesh"/],
    [['set-publisher', '--client-id', 'abc', '--publisher', 'K1lter Labs'], /--publisher: .*imitate "Kilter"/],
    [['set-publisher', '--client-id', 'abc', '--publisher', 'Moon Climbing'], /imitate "Moon Climbing"/],
    [['set-publisher', '--client-id', 'abc', '--publisher', 'ab'], /--publisher: .*3 to 50/],
  ])('refuses %j', (argv, message) => {
    expect(() => parsePartnerAdminArguments(argv)).toThrow(PartnerAdminUsageError);
    expect(() => parsePartnerAdminArguments(argv)).toThrow(message);
  });
});

describe('suspend and unsuspend', () => {
  let environment: PartnerTestEnvironment;

  beforeAll(async () => {
    environment = await createPartnerTestEnvironment();
  });

  afterAll(async () => {
    await environment?.close();
  });

  async function appState(clientId: string) {
    const [app] = await db
      .select({ disabled: oauthClient.disabled })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, clientId));
    const [policy] = await db.select().from(oauthAppPolicy).where(eq(oauthAppPolicy.clientId, clientId));
    return {
      disabled: app.disabled,
      suspendedAt: policy?.suspendedAt ?? null,
      reason: policy?.suspensionReason ?? null,
    };
  }

  it('writes nothing without --apply', async () => {
    const client = await environment.createClient();
    const issued = await environment.issueTokens(client);
    const report = await suspendPartnerApp(db, { clientId: client.clientId, reason: 'Phishing reports', apply: false });
    expect(report).toMatchObject({
      command: 'suspend',
      applied: false,
      changes: true,
      before: { disabled: false, suspendedAt: null, suspensionReason: null },
      after: { disabled: true, suspensionReason: 'Phishing reports' },
    });
    expect(await appState(client.clientId)).toEqual({ disabled: false, suspendedAt: null, reason: null });
    expect((await environment.introspect(client, issued.access_token)).body.active).toBe(true);
  });

  it('sets oauth_client.disabled, so the provider stops the app at once, and unsuspend brings it back', async () => {
    const client = await environment.createClient();
    const issued = await environment.issueTokens(client);

    const suspended = await suspendPartnerApp(db, {
      clientId: client.clientId,
      reason: 'Phishing reports',
      apply: true,
    });
    expect(suspended).toMatchObject({ applied: true, ownerUserId: client.owner.userId, liveConnections: 1 });
    const state = await appState(client.clientId);
    expect(state.disabled).toBe(true);
    expect(state.reason).toBe('Phishing reports');
    expect(state.suspendedAt).toBeInstanceOf(Date);

    // Token, refresh and authorize all check the column.
    expect((await environment.introspect(client, issued.access_token)).body.active).not.toBe(true);
    expect((await environment.refresh(client, issued.refresh_token!)).body.error).toBe('invalid_client');
    const authorize = await environment.authorize(client);
    expect(authorize.location ?? '').not.toContain('code=');

    // Suspending again keeps the first time and takes the new reason.
    const again = await suspendPartnerApp(db, {
      clientId: client.clientId,
      reason: 'Phishing, confirmed',
      apply: true,
    });
    expect(again.applied).toBe(true);
    expect((await appState(client.clientId)).suspendedAt?.getTime()).toBe(state.suspendedAt?.getTime());

    const unsuspended = await unsuspendPartnerApp(db, { clientId: client.clientId, apply: true });
    expect(unsuspended).toMatchObject({ applied: true, after: { disabled: false, suspendedAt: null } });
    expect(await appState(client.clientId)).toEqual({ disabled: false, suspendedAt: null, reason: null });
    // Nothing was deleted: the same refresh token works again.
    expect((await environment.refresh(client, issued.refresh_token!)).response.status).toBe(200);
  });

  it('acts only on an app that exists, and reports when there is nothing to change', async () => {
    await expect(
      suspendPartnerApp(db, { clientId: `missing-${randomUUID()}`, reason: 'Spam', apply: true }),
    ).rejects.toThrow(PartnerAdminUsageError);
    const clientId = await createApp(await createUser('developer'));
    expect(await unsuspendPartnerApp(db, { clientId, apply: true })).toMatchObject({ changes: false, applied: false });
    expect(await suspendPartnerApp(db, { clientId, reason: 'Spam', apply: true })).toMatchObject({ applied: true });
    expect(await suspendPartnerApp(db, { clientId, reason: 'Spam', apply: true })).toMatchObject({
      changes: false,
      applied: false,
    });
  });
});

describe('set-publisher', () => {
  async function publisherOf(clientId: string): Promise<string | null | undefined> {
    const [policy] = await db
      .select({ publisherName: oauthAppPolicy.publisherName })
      .from(oauthAppPolicy)
      .where(eq(oauthAppPolicy.clientId, clientId));
    return policy?.publisherName;
  }

  it('reports without --apply, writes with it, and reports when nothing would change', async () => {
    const clientId = await createApp(await createUser('developer'));
    expect(await publisherOf(clientId)).toBeNull();

    const dryRun = await setPartnerAppPublisher(db, { clientId, publisherName: 'Crimp Labs', apply: false });
    expect(dryRun).toMatchObject({ applied: false, changes: true, before: null, after: 'Crimp Labs' });
    expect(await publisherOf(clientId)).toBeNull();

    const applied = await setPartnerAppPublisher(db, { clientId, publisherName: 'Crimp Labs', apply: true });
    expect(applied).toMatchObject({ applied: true, changes: true, before: null, after: 'Crimp Labs' });
    expect(await publisherOf(clientId)).toBe('Crimp Labs');

    expect(await setPartnerAppPublisher(db, { clientId, publisherName: 'Crimp Labs', apply: true })).toMatchObject({
      applied: false,
      changes: false,
    });
  });

  it('works on a suspended app, which registration refuses to change', async () => {
    const clientId = await createApp(await createUser('developer'));
    await suspendPartnerApp(db, { clientId, reason: 'Impersonation', apply: true });
    await setPartnerAppPublisher(db, { clientId, publisherName: 'Crimp Labs', apply: true });
    expect(await publisherOf(clientId)).toBe('Crimp Labs');
  });

  it('refuses a missing app, and an app with no policy row rather than creating one', async () => {
    await expect(
      setPartnerAppPublisher(db, { clientId: `missing-${randomUUID()}`, publisherName: 'Crimp Labs', apply: true }),
    ).rejects.toThrow(PartnerAdminUsageError);
    const clientId = await createApp(await createUser('developer'));
    await db.delete(oauthAppPolicy).where(eq(oauthAppPolicy.clientId, clientId));
    await expect(setPartnerAppPublisher(db, { clientId, publisherName: 'Crimp Labs', apply: true })).rejects.toThrow(
      /no policy row/,
    );
    expect(await publisherOf(clientId)).toBeUndefined();
  });
});

describe('revoke-user', () => {
  it('reports what it would end without --apply, and ends it with --apply', async () => {
    const rows = await seedConnectedClimber();
    const dryRun = await revokePartnerUser(db, { userId: rows.climberId, apply: false });
    expect(dryRun).toMatchObject({
      applied: false,
      after: null,
      connectionsRevoked: null,
      before: { liveConnections: 1, accessTokens: 2, refreshTokens: 1, grants: 1, pendingCodes: 1, partnerSessions: 1 },
    });
    expect(countsOf(await readPartnerState(rows))).toEqual(INTACT_COUNTS);

    const applied = await revokePartnerUser(db, { userId: rows.climberId, apply: true });
    expect(applied).toMatchObject({ applied: true, connectionsRevoked: 1 });
    expect(applied.after).toEqual({
      liveConnections: 0,
      accessTokens: 0,
      refreshTokens: 0,
      consents: 0,
      refreshAncestors: 0,
      consentScreens: 0,
      partnerSessions: 0,
      grants: 0,
      pendingCodes: 0,
    });
    const state = await readPartnerState(rows);
    expect(countsOf(state)).toEqual(REVOKED_COUNTS);
    expect(state.connection.generation).toBe(1);
    expect(state.connection.revocationReason).toBe('account_security_revocation');
  });

  it('touches no other climber', async () => {
    const target = await seedConnectedClimber('target');
    const bystander = await seedConnectedClimber('bystander');
    await revokePartnerUser(db, { userId: target.climberId, apply: true });
    expect(countsOf(await readPartnerState(bystander))).toEqual(INTACT_COUNTS);
  });

  it('refuses an account that does not exist', async () => {
    await expect(revokePartnerUser(db, { userId: `missing-${randomUUID()}`, apply: true })).rejects.toThrow(
      PartnerAdminUsageError,
    );
  });

  describe('the role and isolation it runs under', () => {
    const roleName = `partner_admin_probe_${randomUUID().replaceAll('-', '')}`;
    const rolePassword = randomBytes(24).toString('hex');
    const owner = postgres(getWorkerDatabaseUrl(), { max: 1, onnotice: () => {} });
    const clients: ReturnType<typeof postgres>[] = [];

    function connectAs(options: { role?: string; isolation?: 'repeatable read' } = {}) {
      const url = new URL(getWorkerDatabaseUrl());
      if (options.role) {
        url.username = options.role;
        url.password = rolePassword;
      }
      const client = postgres(url.toString(), {
        max: 1,
        onnotice: () => {},
        ...(options.isolation ? { connection: { default_transaction_isolation: options.isolation } } : {}),
      });
      clients.push(client);
      return { client, database: drizzle(client) as unknown as PartnerAdminDatabase };
    }

    beforeAll(async () => {
      // What the migration runner's ACL reconcile gives boardsesh_runtime.
      await owner.unsafe(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${rolePassword}' NOINHERIT`);
      await owner.unsafe(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
      await owner.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${roleName}"`);
      await owner.unsafe(`GRANT EXECUTE ON FUNCTION public.partner_revoke_user(text) TO "${roleName}"`);
    });

    afterAll(async () => {
      await Promise.all(clients.map((client) => client.end({ timeout: 5 })));
      await owner.unsafe(`DROP OWNED BY "${roleName}"; DROP ROLE "${roleName}"`);
      await owner.end({ timeout: 5 });
    });

    it('works as a role with the runtime grants: DML on every table and EXECUTE', async () => {
      const rows = await seedConnectedClimber();
      const runtimeLike = connectAs({ role: roleName });
      expect(await revokePartnerUser(runtimeLike.database, { userId: rows.climberId, apply: true })).toMatchObject({
        connectionsRevoked: 1,
      });
      expect(countsOf(await readPartnerState(rows))).toEqual(REVOKED_COUNTS);
    });

    it('needs UPDATE on users, because the function locks the climber row', async () => {
      const rows = await seedConnectedClimber();
      await owner.unsafe(`REVOKE UPDATE ON TABLE users FROM "${roleName}"`);
      try {
        const withoutUsersUpdate = connectAs({ role: roleName });
        await expect(
          revokePartnerUser(withoutUsersUpdate.database, { userId: rows.climberId, apply: true }),
        ).rejects.toMatchObject({ cause: { code: '42501' } });
      } finally {
        await owner.unsafe(`GRANT UPDATE ON TABLE users TO "${roleName}"`);
      }
      expect(countsOf(await readPartnerState(rows))).toEqual(INTACT_COUNTS);
    });

    it('asks for READ COMMITTED itself, whatever the login defaults to', async () => {
      const rows = await seedConnectedClimber();
      const repeatableRead = connectAs({ isolation: 'repeatable read' });
      // The function refuses the login's default on its own...
      await expect(repeatableRead.client`select public.partner_revoke_user(${rows.climberId})`).rejects.toMatchObject({
        code: '55000',
      });
      expect(countsOf(await readPartnerState(rows))).toEqual(INTACT_COUNTS);
      // ...and the command still runs, because it opens READ COMMITTED.
      expect(await revokePartnerUser(repeatableRead.database, { userId: rows.climberId, apply: true })).toMatchObject({
        connectionsRevoked: 1,
      });
      expect(countsOf(await readPartnerState(rows))).toEqual(REVOKED_COUNTS);
    });

    it('opens a dry run read-only, so it cannot write even by mistake', async () => {
      const rows = await seedConnectedClimber();
      const observed: Array<string | undefined> = [];
      const probe = connectAs();
      const probing: PartnerAdminDatabase = {
        transaction: (work, config) =>
          probe.database.transaction(async (transaction) => {
            const setting = await executeFirstRow<{ transaction_read_only: string }>(
              transaction,
              sql`show transaction_read_only`,
            );
            observed.push(setting?.transaction_read_only);
            return work(transaction);
          }, config),
      };
      await revokePartnerUser(probing, { userId: rows.climberId, apply: false });
      await suspendPartnerApp(probing, { clientId: rows.clientId, reason: 'Spam', apply: false });
      await unsuspendPartnerApp(probing, { clientId: rows.clientId, apply: false });
      await setPartnerAppPublisher(probing, { clientId: rows.clientId, publisherName: 'Crimp Labs', apply: false });
      expect(observed).toEqual(['on', 'on', 'on', 'on']);
      expect(countsOf(await readPartnerState(rows))).toEqual(INTACT_COUNTS);
    });
  });
});
