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
    // Explicit columns: Drizzle's insert would name every current schema column,
    // and only these two legacy migrations ran in this database.
    await fixtureClient`
      INSERT INTO users (id, email, "emailVerified") VALUES
        ('audit-password-user', 'Legacy.Audit@example.test', '2026-01-01'),
        ('audit-provider-user', ' legacy.audit@example.test ', NULL)`;
    await fixtureClient`
      INSERT INTO user_credentials (user_id, password_hash)
      VALUES ('audit-password-user', '$2b$10$CwTycUXWue0Thq9StjUM0uJ8/oQbk1Ec7T0p/7K8nXfRzC2VyM4dy')`;
    await fixtureClient`
      INSERT INTO accounts ("userId", type, provider, "providerAccountId")
      VALUES ('audit-provider-user', 'oauth', 'apple', 'audit-private-subject')`;
  });

  afterAll(async () => {
    await fixtureClient?.end({ timeout: 5 });
    await environment?.close();
  });

  // The audited columns only, so a future column on these tables cannot fail
  // with a missing-column error here (only migrations 0016/0017 were applied).
  async function readAuditedSourceRows() {
    const database = drizzle(fixtureClient);
    return {
      users: await database
        .select({ id: users.id, email: users.email, emailVerified: users.emailVerified })
        .from(users),
      credentials: await database
        .select({ userId: userCredentials.userId, passwordHash: userCredentials.passwordHash })
        .from(userCredentials),
      providerAccounts: await database
        .select({
          userId: accounts.userId,
          provider: accounts.provider,
          providerAccountId: accounts.providerAccountId,
        })
        .from(accounts),
    };
  }

  it('selects legacy identity columns and leaves all source records unchanged', async () => {
    const before = await readAuditedSourceRows();

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
    expect(await readAuditedSourceRows()).toEqual(before);
  });

  it('remeasures the selected database on every run with fresh private references', async () => {
    const firstReport = await runIdentityAudit({ AUTH_IDENTITY_AUDIT_DATABASE_URL: environment.databaseUrl });
    await fixtureClient`INSERT INTO users (id, email) VALUES ('audit-new-user', 'new-audit@example.test')`;
    const secondReport = await runIdentityAudit({ AUTH_IDENTITY_AUDIT_DATABASE_URL: environment.databaseUrl });
    expect(secondReport.counts.users).toBe(firstReport.counts.users + 1);
    expect(secondReport.counts.usersWithoutSignInMethods).toBe(firstReport.counts.usersWithoutSignInMethods + 1);
    const firstCollision = firstReport.findings.find((finding) => finding.kind === 'normalized-email-collision');
    const secondCollision = secondReport.findings.find((finding) => finding.kind === 'normalized-email-collision');
    expect(firstCollision).toBeDefined();
    expect(secondCollision?.reference).not.toBe(firstCollision?.reference);
  });
});
