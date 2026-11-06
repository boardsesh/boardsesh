import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  accounts,
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  sessions,
  userProfiles,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { eq, sql, type SQL } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { db } from '../../../db/client';
import { setupWorkerDatabase } from '../../../__tests__/worker-db';
import { prepareProjectionUnderUsersTableLock, reserveEnforcedEmail } from '../email-reservations';
import { CURRENT_EMAIL_NORMALIZER_VERSION, type ExpectedCurrentStoreAuthority } from '../foundation-context';
import { recordSecurityMutation } from '../security-mutations';
import { startAppRouterCompound } from './fixtures/app-router-compound';
import { RouteExportBrowser, startAppRouterHarness } from './fixtures/app-router-harness';
import type { ConfiguredIdentity, ConfiguredProvider } from './fixtures/app-router-providers';

const salt = randomUUID().replaceAll('-', '');
const readRole = `ba03_router_readonly_${salt}`;
const writerRole = `ba03_router_writer_${salt}`;
const password = randomBytes(32).toString('hex');
const tracked: string[] = [];
const mutable = [
  users,
  accounts,
  userProfiles,
  sessions,
  verificationTokens,
  authEmailProjection,
  authEmailReservations,
  authEmailReservationMembers,
  authSubjectCutoffs,
];
const allTables = [...mutable, authSecurityMutationEvents];
let pool: ReturnType<typeof postgres> | undefined;
let readUrl: string;
let authority: ExpectedCurrentStoreAuthority;
const resources: { close(): Promise<void> }[] = [];
async function admin(statement: SQL) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout='5000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout='4000ms'`);
    return transaction.execute(statement);
  });
}
async function closeResources() {
  const failures: Error[] = [];
  for (const resource of resources.splice(0).reverse()) {
    try {
      await resource.close();
    } catch {
      failures.push(new Error('Owned delegation resource cleanup failed'));
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Owned delegation teardown failed');
}
function identity(): ConfiguredIdentity {
  const subject = randomUUID();
  return { subject, email: `${subject}@example.test`, name: 'Compound Browser Owner', emailVerified: true };
}
async function fixture(
  faults: {
    failEvent?: boolean;
    failEncode?: boolean;
    pauseBeforeEncode?: boolean;
    discardConflictResponse?: boolean;
    discardSuccessfulCompoundResponse?: boolean;
  } = {},
) {
  if (!pool) throw new Error('Missing restricted writer pool');
  const nextAuthSecret = randomBytes(32).toString('base64url');
  const compound = await startAppRouterCompound({ database: drizzle(pool), authority, nextAuthSecret });
  let stopping: Promise<void> | undefined;
  const stopBackend = () => (stopping ??= compound.close());
  resources.push({ close: stopBackend });
  const harness = await startAppRouterHarness({
    databaseUrl: readUrl,
    nextAuthSecret,
    compound: { origin: compound.origin, secret: compound.secret },
    faults,
  });
  resources.push(harness);
  return { compound, harness, browser: new RouteExportBrowser(harness), stopBackend };
}
async function validate(current: Awaited<ReturnType<typeof fixture>>, cookie: string) {
  return fetch(`${current.compound.origin}/validate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${current.compound.secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ actorCookie: cookie }),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
}
async function seedOwner(profile: ConfiguredIdentity, provider: ConfiguredProvider, owner = randomUUID()) {
  await db.transaction(async (transaction) => {
    await reserveEnforcedEmail(transaction, { ...authority, rawEmail: profile.email!, requestedUserId: owner });
    await transaction.insert(users).values({ id: owner, email: profile.email!, name: 'Preserved Local Owner' });
    await transaction.insert(userProfiles).values({ userId: owner });
    await transaction
      .insert(accounts)
      .values({ userId: owner, provider, providerAccountId: profile.subject, type: 'oauth' });
  });
  return owner;
}

describe('actual App Router providers with explicitly fixture-only compound delegation', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
    await db.transaction(async (transaction) => {
      for (const role of [readRole, writerRole]) {
        await transaction.execute(
          sql`CREATE ROLE ${sql.identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${password}'`)}`,
        );
        tracked.push(role);
        await transaction.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(role)}`);
      }
      // Owned fixture-only drain/transfer: the old web adapter loses writes.
      await transaction.execute(
        sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${users}, ${accounts}, ${userProfiles} TO ${sql.identifier(readRole)}`,
      );
      await transaction.execute(sql`LOCK TABLE ${users}, ${accounts}, ${userProfiles} IN ACCESS EXCLUSIVE MODE`);
      await transaction.execute(
        sql`REVOKE ALL PRIVILEGES ON TABLE ${users}, ${accounts}, ${userProfiles} FROM ${sql.identifier(readRole)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT ON TABLE ${users}, ${accounts}, ${userProfiles}, ${authSubjectCutoffs} TO ${sql.identifier(readRole)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${sql.join(mutable, sql`, `)} TO ${sql.identifier(writerRole)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT, INSERT ON TABLE ${authSecurityMutationEvents} TO ${sql.identifier(writerRole)}`,
      );
    });
    const base = new URL(process.env.DATABASE_URL ?? '');
    base.password = password;
    base.username = readRole;
    readUrl = base.href;
    base.username = writerRole;
    pool = postgres(base.href, {
      max: 3,
      connect_timeout: 3,
      onnotice: () => {},
      connection: { statement_timeout: 6000, lock_timeout: 4000 },
    });
  });
  beforeEach(async () => {
    await closeResources();
    await db.delete(verificationTokens);
    await db.delete(sessions);
    await db.delete(authEmailReservationMembers);
    await db.delete(authEmailReservations);
    await db.delete(authSecurityMutationEvents);
    await db.delete(authSubjectCutoffs);
    await db.delete(authEmailProjection);
    await db.delete(users);
    const projectionId = randomUUID();
    authority = {
      expectedProjectionId: projectionId,
      expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      expectedWriterEpoch: 1,
    };
    await db.transaction(async (transaction) => {
      await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
      await transaction
        .update(authEmailProjection)
        .set({ phase: 'enforced' })
        .where(eq(authEmailProjection.projectionId, projectionId));
    });
  });
  afterAll(async () => {
    const failures: Error[] = [];
    try {
      await closeResources();
    } catch {
      failures.push(new Error('Owned delegate child cleanup failed'));
    }
    try {
      await pool?.end({ timeout: 3 });
    } catch {
      failures.push(new Error('Owned delegate pool cleanup failed'));
    }
    for (const role of tracked) {
      try {
        await admin(sql`REVOKE ALL PRIVILEGES ON TABLE ${sql.join(allTables, sql`, `)} FROM ${sql.identifier(role)}`);
      } catch {
        failures.push(new Error('Owned delegate grant cleanup failed'));
      }
      try {
        await admin(sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${sql.identifier(role)}`);
      } catch {
        failures.push(new Error('Owned delegate schema cleanup failed'));
      }
      try {
        await admin(sql`DROP ROLE IF EXISTS ${sql.identifier(role)}`);
      } catch {
        failures.push(new Error('Owned delegate role cleanup failed'));
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned delegate teardown failed');
  });

  it.each<ConfiguredProvider>(['google', 'apple', 'facebook'])(
    'creates exact %s identity through real callback and backend transaction, with adapter writes denied',
    async (provider) => {
      const current = await fixture();
      const profile = identity();
      const result = await current.browser.complete(provider, profile);
      expect(result.response.status).toBe(302);
      expect(result.response.location).toBe(`${current.harness.origin}/signed-in`);
      if (provider === 'apple') expect(result.handoff.status).toBe(303);
      const owner = (await db.select().from(users))[0];
      expect(Boolean(owner && owner.email === profile.email && owner.emailVerified === null)).toBe(true);
      expect(
        await db
          .select({ owner: accounts.userId, provider: accounts.provider, subject: accounts.providerAccountId })
          .from(accounts),
      ).toEqual([{ owner: owner.id, provider, subject: profile.subject }]);
      const claims = await current.browser.claims();
      expect(
        claims?.sub === owner.id && claims.accountCreated === true && claims.originalAuthenticatedAt === null,
      ).toBe(true);
      expect((await validate(current, current.browser.session())).status).toBe(200);
      const snapshot = (await current.harness.call('snapshot')) as {
        delegate: { deniedMutations: string[]; stockIsNewUser: boolean[] };
      };
      expect(snapshot.delegate.deniedMutations).toEqual([]);
      expect(snapshot.delegate.stockIsNewUser).toEqual([false]);
    },
    30000,
  );

  it('retains owned subject UID/email/verification despite missing provider email', async () => {
    const profile = identity();
    const owner = await seedOwner(profile, 'google');
    const verifiedAt = new Date('2025-01-02T03:04:05.000Z');
    await db.update(users).set({ emailVerified: verifiedAt }).where(eq(users.id, owner));
    const current = await fixture();
    const result = await current.browser.complete('google', { subject: profile.subject });
    expect(result.response.status).toBe(302);
    expect((await current.browser.claims())?.sub === owner).toBe(true);
    const rows = await db.select().from(users);
    expect(
      rows.length === 1 && rows[0].email === profile.email && rows[0].emailVerified?.getTime() === verifiedAt.getTime(),
    ).toBe(true);
  }, 30000);

  it('denies an unknown Facebook subject matching an occupied normalized email without auto-link or cookie', async () => {
    const existing = identity();
    await seedOwner(existing, 'google');
    const current = await fixture();
    const result = await current.browser.complete('facebook', { ...identity(), email: existing.email!.toUpperCase() });
    expect(result.response.status).toBe(503);
    expect(result.response.cookies).toEqual([]);
    expect((await db.select().from(users)).length).toBe(1);
    expect((await db.select().from(accounts)).every((row) => row.provider === 'google')).toBe(true);
    expect(await db.select().from(sessions)).toEqual([]);
  }, 30000);

  it.each(['different-user', 'same-user-new-sid', 'revoked'] as const)(
    'rejects callback actor change %s without replacing the initiating login',
    async (change) => {
      const profile = identity();
      const owner = await seedOwner(profile, 'google');
      const current = await fixture();
      const source = await current.compound.issueSource(owner, null);
      current.browser.cookies.set('__Secure-next-auth.session-token', source.cookie);
      const authorization = await current.browser.start('google');
      const callback = await current.harness.authorize(authorization, profile);
      if (change === 'revoked') await current.compound.revokeSource(source.sourceProof);
      else {
        let changedOwner = owner;
        if (change === 'different-user') changedOwner = await seedOwner(identity(), 'apple');
        const replacement = await current.compound.issueSource(changedOwner, null);
        current.browser.cookies.set('__Secure-next-auth.session-token', replacement.cookie);
      }
      const before = current.browser.session();
      const response = await current.browser.request(callback.url);
      expect(response.status).toBe(503);
      expect(response.cookies).toEqual([]);
      expect(current.browser.session() === before).toBe(true);
      expect((await db.select().from(accounts)).filter((row) => row.provider === 'google').length).toBe(1);
    },
    30000,
  );

  it.each([false, true])(
    'preserves the winning Google issuance when a sibling conflict is discarded=%s',
    async (discardConflictResponse) => {
      const current = await fixture({ discardConflictResponse });
      const profile = identity();
      const authorization = await current.browser.start('google');
      const first = await current.harness.authorize(authorization, profile);
      const second = await current.harness.authorize(authorization, profile);
      const sibling = new RouteExportBrowser(current.harness);
      for (const [name, content] of current.browser.cookies) sibling.cookies.set(name, content);
      const responses = await Promise.all([current.browser.request(first.url), sibling.request(second.url)]);
      expect(responses.map((response) => response.status).sort((first, second) => first - second)).toEqual([302, 503]);
      expect((await db.select().from(users)).length).toBe(1);
      expect((await db.select().from(accounts)).length).toBe(1);
      expect((await db.select().from(sessions)).length).toBe(1);
      const winner = responses[0].status === 302 ? current.browser : sibling;
      expect((await validate(current, winner.session())).status).toBe(200);
      const snapshot = (await current.harness.call('snapshot')) as { delegate: { abortAcknowledged: boolean[] } };
      expect(snapshot.delegate.abortAcknowledged).toEqual(discardConflictResponse ? [true] : []);
    },
    30000,
  );

  it('withholds publication after a received committed reply is discarded and aborts only that attempt', async () => {
    const profile = identity();
    const owner = await seedOwner(profile, 'google');
    const current = await fixture({ discardSuccessfulCompoundResponse: true });
    const sibling = await current.compound.issueSource(owner, null);
    const result = await current.browser.complete('google', profile);
    expect(result.response.status).toBe(503);
    expect(result.response.cookies).toEqual([]);
    expect(current.browser.session()).toHaveLength(0);
    expect((await validate(current, sibling.cookie)).status).toBe(200);
    expect((await db.select().from(sessions)).length).toBe(1);
    expect((await db.select().from(users)).length).toBe(1);
    expect((await db.select().from(accounts)).length).toBe(1);
    const snapshot = (await current.harness.call('snapshot')) as { delegate: { abortAcknowledged: boolean[] } };
    expect(snapshot.delegate.abortAcknowledged).toEqual([true]);
  }, 30000);

  it('preserves the original login when the private backend closes after intent registration', async () => {
    const profile = identity();
    const owner = await seedOwner(profile, 'google');
    const current = await fixture();
    const source = await current.compound.issueSource(owner, null);
    current.browser.cookies.set('__Secure-next-auth.session-token', source.cookie);
    const authorization = await current.browser.start('google');
    const callback = await current.harness.authorize(authorization, profile);
    await current.stopBackend();
    const response = await current.browser.request(callback.url);
    expect(response.status).toBe(503);
    expect(response.cookies).toEqual([]);
    expect(current.browser.session() === source.cookie).toBe(true);
    expect((await db.select().from(sessions)).length).toBe(1);
    const snapshot = (await current.harness.call('snapshot')) as { delegate: { abortAcknowledged: boolean[] } };
    expect(snapshot.delegate.abortAcknowledged).toEqual([false]);
  }, 30000);

  it.each(['failEvent', 'failEncode'] as const)(
    'blocks publication and removes exact issuance after real late %s failure',
    async (fault) => {
      const profile = identity();
      const owner = await seedOwner(profile, 'google');
      const current = await fixture({ [fault]: true });
      const sibling = await current.compound.issueSource(owner, null);
      const result = await current.browser.complete('google', profile);
      expect(result.response.status).toBe(503);
      expect(result.response.cookies).toEqual([]);
      expect(current.browser.session().length).toBe(0);
      expect((await validate(current, sibling.cookie)).status).toBe(200);
      expect((await db.select().from(sessions)).length).toBe(1);
      expect((await db.select().from(users)).length).toBe(1);
      const snapshot = (await current.harness.call('snapshot')) as { delegate: { abortAcknowledged: boolean[] } };
      expect(snapshot.delegate.abortAcknowledged).toEqual([true]);
    },
    30000,
  );
  it.each(['reset', 'deletion'] as const)(
    'does not publish when %s invalidates the committed source before encoding',
    async (mutation) => {
      const profile = identity();
      const owner = await seedOwner(profile, 'google');
      const current = await fixture({ pauseBeforeEncode: true });
      const completion = current.browser.complete('google', profile);
      void completion.catch(() => {});
      try {
        await current.harness.waitEncodeCheckpoint();
        expect((await db.select().from(sessions)).length).toBe(1);
        await db.transaction(async (transaction) => {
          await recordSecurityMutation(transaction, {
            ...authority,
            userId: owner,
            expectedGeneration: 0,
            operationId: randomUUID(),
            kind: mutation === 'reset' ? 'password-reset' : 'account-deletion',
            domains: ['first-party', 'partner'],
          });
          if (mutation === 'deletion') await transaction.delete(users).where(eq(users.id, owner));
        });
      } finally {
        await current.harness.call('resume-encode');
      }
      const result = await completion;
      expect(result.response.status).toBe(503);
      expect(result.response.cookies).toEqual([]);
      expect(current.browser.session().length).toBe(0);
      expect(await db.select().from(sessions)).toEqual([]);
    },
    30000,
  );

  it.each(['__Secure-next-auth.session-token', 'next-auth.session-token'])(
    'rejects a bare %s Cookie part without losing its actor-presence evidence',
    async (bareName) => {
      const current = await fixture();
      const csrf = await current.browser.request('/api/auth/csrf');
      const csrfToken = (JSON.parse(csrf.body) as { csrfToken: string }).csrfToken;
      const response = await current.harness.request('/api/auth/signin/google', {
        method: 'POST',
        cookie: `${current.browser.header()}; ${bareName}`,
        form: new URLSearchParams({ csrfToken, callbackUrl: `${current.harness.origin}/signed-in` }).toString(),
      });
      expect(response.status).toBe(503);
      expect(response.cookies).toEqual([]);
      expect(current.compound.facts.intents).toBe(0);
      expect(await db.select().from(verificationTokens)).toEqual([]);
      expect(await db.select().from(users)).toEqual([]);
      expect(await db.select().from(accounts)).toEqual([]);
    },
    30000,
  );

  it.each(['invalid-jwe', 'unknown-session-suffix'] as const)(
    'does not treat present %s actor evidence as anonymous initiation',
    async (kind) => {
      const current = await fixture();
      current.browser.cookies.set(
        kind === 'invalid-jwe' ? '__Secure-next-auth.session-token' : '__Secure-next-auth.session-token.unknown',
        'unreadable-existing-actor',
      );
      const before = current.browser.header();
      const csrf = await current.browser.request('/api/auth/csrf');
      const csrfToken = (JSON.parse(csrf.body) as { csrfToken: string }).csrfToken;
      const result = await current.browser.request('/api/auth/signin/google', {
        method: 'POST',
        form: new URLSearchParams({ csrfToken, callbackUrl: `${current.harness.origin}/signed-in` }).toString(),
      });
      expect(result.status).toBe(503);
      expect(result.cookies).toEqual([]);
      expect(current.browser.header().includes(before)).toBe(true);
      expect(await db.select().from(users)).toEqual([]);
      expect(await db.select().from(accounts)).toEqual([]);
    },
    30000,
  );
});
