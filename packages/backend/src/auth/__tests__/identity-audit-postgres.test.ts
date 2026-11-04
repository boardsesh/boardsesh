import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { users, userCredentials, accounts } from '@boardsesh/db/schema/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createPrototypeEnvironment } from '../prototype/environment';
import { runIdentityAudit } from '../../scripts/audit-auth-identities';

describe('read-only audit against a disposable legacy identity database', () => {
  let environment: Awaited<ReturnType<typeof createPrototypeEnvironment>>;
  let fixtureClient: ReturnType<typeof postgres>;

  beforeAll(async () => {
    environment = await createPrototypeEnvironment();
    fixtureClient = postgres(environment.databaseUrl, { max: 1, onnotice: () => {} });
    // Reuse real generated legacy migrations in this newly created database.
    // No ad-hoc production migration or application's DATABASE_URL is involved.
    for (const migration of ['0016_exotic_valkyrie.sql', '0017_puzzling_mikhail_rasputin.sql']) {
      const migrationSql = readFileSync(new URL(`../../../../db/drizzle/${migration}`, import.meta.url), 'utf8');
      for (const statement of migrationSql.split('--> statement-breakpoint')) {
        if (statement.trim()) await fixtureClient.unsafe(statement);
      }
    }
    const database = drizzle(fixtureClient);
    await database.insert(users).values([
      { id: 'audit-password-user', email: 'Legacy.Audit@example.test', emailVerified: new Date('2026-01-01') },
      { id: 'audit-provider-user', email: ' legacy.audit@example.test ' },
    ]);
    await database.insert(userCredentials).values({
      userId: 'audit-password-user',
      passwordHash: '$2b$10$CwTycUXWue0Thq9StjUM0uJ8/oQbk1Ec7T0p/7K8nXfRzC2VyM4dy',
    });
    await database.insert(accounts).values({
      userId: 'audit-provider-user',
      type: 'oauth',
      provider: 'apple',
      providerAccountId: 'audit-private-subject',
    });
  });

  afterAll(async () => {
    await fixtureClient?.end({ timeout: 5 });
    await environment?.close();
  });

  it('selects legacy identity columns and leaves all source records unchanged', async () => {
    const database = drizzle(fixtureClient);
    const before = {
      users: await database.select().from(users),
      credentials: await database.select().from(userCredentials),
      providerAccounts: await database.select().from(accounts),
    };

    const report = await runIdentityAudit({ AUTH_IDENTITY_AUDIT_DATABASE_URL: environment.databaseUrl });
    expect(report.counts).toMatchObject({
      users: 2,
      credentials: 1,
      providerAccounts: 1,
      normalizedEmailCollisionGroups: 1,
      caseVariantCollisionGroups: 1,
      whitespaceVariantCollisionGroups: 1,
      malformedBcryptCredentials: 0,
      usersWithoutSignInMethods: 0,
    });
    expect(JSON.stringify(report)).not.toContain('audit-private-subject');
    expect(JSON.stringify(report)).not.toContain('example.test');
    expect(await database.select().from(users)).toEqual(before.users);
    expect(await database.select().from(userCredentials)).toEqual(before.credentials);
    expect(await database.select().from(accounts)).toEqual(before.providerAccounts);
  });

  it('remeasures the selected database on every run with fresh private references', async () => {
    const firstReport = await runIdentityAudit({ AUTH_IDENTITY_AUDIT_DATABASE_URL: environment.databaseUrl });
    await drizzle(fixtureClient).insert(users).values({ id: 'audit-new-user', email: 'new-audit@example.test' });
    const secondReport = await runIdentityAudit({ AUTH_IDENTITY_AUDIT_DATABASE_URL: environment.databaseUrl });
    expect(secondReport.counts.users).toBe(firstReport.counts.users + 1);
    expect(secondReport.counts.usersWithoutSignInMethods).toBe(firstReport.counts.usersWithoutSignInMethods + 1);
    const firstCollision = firstReport.findings.find((finding) => finding.kind === 'normalized-email-collision');
    const secondCollision = secondReport.findings.find((finding) => finding.kind === 'normalized-email-collision');
    expect(firstCollision).toBeDefined();
    expect(secondCollision?.reference).not.toBe(firstCollision?.reference);
  });
});
