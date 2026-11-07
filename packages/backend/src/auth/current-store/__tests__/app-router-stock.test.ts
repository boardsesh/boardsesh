import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  accounts,
  authSubjectCutoffs,
  sessions,
  userCredentials,
  userProfiles,
  users,
  verificationTokens,
} from '@boardsesh/db/schema/auth';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../../db/client';
import { setupWorkerDatabase } from '../../../__tests__/worker-db';
import { RouteExportBrowser, startAppRouterHarness } from './fixtures/app-router-harness';
import type { ConfiguredIdentity, ConfiguredProvider } from './fixtures/app-router-providers';

const role = `ba03_router_stock_${randomUUID().replaceAll('-', '')}`;
const password = randomBytes(32).toString('hex');
const tables = [users, accounts, userCredentials, userProfiles, sessions, verificationTokens];
const admissionReadTables = [authSubjectCutoffs];
let roleTracked = false;
let harness: Awaited<ReturnType<typeof startAppRouterHarness>> | undefined;
async function admin(statement: SQL) {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL statement_timeout='5000ms'`);
    await transaction.execute(sql`SET LOCAL lock_timeout='4000ms'`);
    return transaction.execute(statement);
  });
}
function identity(): ConfiguredIdentity {
  const subject = randomUUID();
  return { subject, email: `${subject}@example.test`, name: 'Owned Browser Climber', emailVerified: true };
}
function browser() {
  if (!harness) throw new Error('Missing owned App Router');
  return new RouteExportBrowser(harness);
}

describe('actual App Router and configured providers: stock characterization', () => {
  beforeAll(async () => {
    await setupWorkerDatabase();
    await db.transaction(async (transaction) => {
      await transaction.execute(
        sql`CREATE ROLE ${sql.identifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${sql.raw(`'${password}'`)}`,
      );
      roleTracked = true;
      await transaction.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(role)}`);
      await transaction.execute(
        sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${sql.join(tables, sql`, `)} TO ${sql.identifier(role)}`,
      );
      await transaction.execute(
        sql`GRANT SELECT ON TABLE ${sql.join(admissionReadTables, sql`, `)} TO ${sql.identifier(role)}`,
      );
    });
    const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
    databaseUrl.username = role;
    databaseUrl.password = password;
    harness = await startAppRouterHarness({ databaseUrl: databaseUrl.href });
  }, 30000);
  beforeEach(async () => {
    await db.delete(verificationTokens);
    await db.delete(users);
  });
  afterAll(async () => {
    const failures: Error[] = [];
    try {
      await harness?.close();
    } catch {
      failures.push(new Error('Owned App Router teardown failed'));
    }
    if (roleTracked) {
      try {
        await admin(
          sql`REVOKE ALL PRIVILEGES ON TABLE ${sql.join([...tables, ...admissionReadTables], sql`, `)} FROM ${sql.identifier(role)}`,
        );
      } catch {
        failures.push(new Error('Owned grants cleanup failed'));
      }
      try {
        await admin(sql`REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${sql.identifier(role)}`);
      } catch {
        failures.push(new Error('Owned schema cleanup failed'));
      }
      try {
        await admin(sql`DROP ROLE IF EXISTS ${sql.identifier(role)}`);
      } catch {
        failures.push(new Error('Owned role cleanup failed'));
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Owned stock proof cleanup failed');
  });

  it.each<ConfiguredProvider>(['google', 'apple', 'facebook'])(
    'runs actual configured %s code exchange and profile/account creation through the actual route export',
    async (provider) => {
      const current = browser();
      const profile = identity();
      const result = await current.complete(provider, profile);
      expect(result.response.status).toBe(302);
      expect(result.response.location).toBe(`${harness!.origin}/signed-in`);
      const [owner] = await db.select().from(users);
      expect(Boolean(owner && owner.email === profile.email && owner.name === profile.name)).toBe(true);
      expect(
        await db
          .select({ owner: accounts.userId, provider: accounts.provider, subject: accounts.providerAccountId })
          .from(accounts),
      ).toEqual([{ owner: owner.id, provider, subject: profile.subject }]);
      expect(await db.select({ owner: userProfiles.userId }).from(userProfiles)).toEqual([{ owner: owner.id }]);
      expect((await current.claims())?.sub === owner.id).toBe(true);
      expect(
        result.response.cookies.some(
          (cookie) =>
            cookie.startsWith('__Secure-next-auth.session-token=') &&
            /SameSite=Lax/i.test(cookie) &&
            /HttpOnly/i.test(cookie) &&
            /Secure/i.test(cookie),
        ),
      ).toBe(true);
      const authorization = new URL(result.authorization);
      expect(Boolean(authorization.searchParams.get('state'))).toBe(true);
      expect(authorization.searchParams.has('nonce')).toBe(false);
      expect(authorization.searchParams.has('code_challenge')).toBe(provider !== 'facebook');
      if (provider === 'apple') {
        expect(result.callback.method).toBe('POST');
        expect(authorization.searchParams.get('response_mode')).toBe('form_post');
        const snapshot = (await harness!.call('snapshot')) as {
          providerRequests: { provider: string; operation: string; authentication?: string }[];
        };
        expect(
          snapshot.providerRequests.filter((entry) => entry.provider === 'apple' && entry.operation === 'token').at(-1)
            ?.authentication,
        ).toBe('client_secret_post');
      }
    },
  );

  it('characterizes dangerous email linking: an unknown Facebook subject attaches to the existing exact-email owner', async () => {
    const profile = identity();
    const owner = randomUUID();
    await db.insert(users).values({ id: owner, email: profile.email!, name: 'Existing Owner' });
    const current = browser();
    const result = await current.complete('facebook', profile);
    expect(result.response.status).toBe(302);
    expect((await current.claims())?.sub === owner).toBe(true);
    expect(await db.select({ owner: accounts.userId }).from(accounts)).toEqual([{ owner }]);
    expect((await db.select().from(users)).length).toBe(1);
  });

  it('characterizes verification mutation: a second linked Facebook login marks the local address verified without a provider verification claim', async () => {
    const current = browser();
    const profile = identity();
    delete profile.emailVerified;
    await current.complete('facebook', profile);
    const [first] = await db.select().from(users);
    expect(first.emailVerified).toBeNull();
    await current.complete('facebook', profile);
    const [second] = await db.select().from(users);
    expect(second.emailVerified instanceof Date).toBe(true);
  });

  it.each<ConfiguredProvider>(['google', 'apple', 'facebook'])(
    'retains linked owner when returning %s profile omits email',
    async (provider) => {
      const current = browser();
      const profile = identity();
      await current.complete(provider, profile);
      const owner = (await db.select().from(users))[0];
      const repeated = await browser().complete(provider, { subject: profile.subject });
      expect(repeated.response.status).toBe(302);
      const rows = await db.select().from(users);
      expect(rows.length === 1 && rows[0].id === owner.id && rows[0].email === owner.email).toBe(true);
    },
  );

  it.each<ConfiguredProvider>(['google', 'apple', 'facebook'])(
    'does not create identity on configured %s provider cancellation',
    async (provider) => {
      const current = browser();
      const result = await current.complete(provider, identity(), { cancel: true });
      expect(result.response.status).toBe(302);
      expect(new URL(result.response.location!).pathname).toBe('/api/auth/error');
      expect(new URL(result.response.location!).searchParams.get('error')).toBe('Callback');
      expect(current.session().length).toBe(0);
      expect(await db.select().from(users)).toEqual([]);
      expect(await db.select().from(accounts)).toEqual([]);
    },
  );

  it.each<ConfiguredProvider>(['google', 'apple', 'facebook'])(
    'does not publish a session when configured %s token exchange fails',
    async (provider) => {
      const current = browser();
      const result = await current.complete(provider, identity(), { rejectToken: true });
      expect(result.response.status).toBe(302);
      expect(new URL(result.response.location!).searchParams.get('error')).toBe('OAuthCallback');
      expect(current.session().length).toBe(0);
      expect(await db.select().from(users)).toEqual([]);
    },
  );

  it.each(['google', 'apple'] as const)('really validates %s ID-token signature and audience', async (provider) => {
    for (const faults of [
      { wrongSignature: true },
      { wrongAudience: true },
      { wrongIssuer: true },
      { expired: true },
    ]) {
      const current = browser();
      const result = await current.complete(provider, identity(), faults);
      expect(result.response.status).toBe(302);
      expect(new URL(result.response.location!).searchParams.get('error')).toBe('OAuthCallback');
      expect(current.session().length).toBe(0);
      expect(await db.select().from(users)).toEqual([]);
    }
  });

  it.each(['missingResponseIssuer', 'wrongResponseIssuer'] as const)(
    'rejects Google %s before any token request',
    async (fault) => {
      const snapshot = (await harness!.call('snapshot')) as { providerRequests: { operation: string }[] };
      const before = snapshot.providerRequests.filter((entry) => entry.operation === 'token').length;
      const current = browser();
      const result = await current.complete('google', identity(), { [fault]: true });
      expect(result.response.status).toBe(302);
      expect(new URL(result.response.location!).searchParams.get('error')).toBe('OAuthCallback');
      expect(current.session()).toHaveLength(0);
      expect(await db.select().from(users)).toEqual([]);
      const after = (await harness!.call('snapshot')) as { providerRequests: { operation: string }[] };
      expect(after.providerRequests.filter((entry) => entry.operation === 'token').length).toBe(before);
    },
  );

  it('enforces actual state and PKCE before any profile callback or writer', async () => {
    const current = browser();
    const authorization = await current.start('google');
    const callback = await harness!.authorize(authorization, identity());
    const tampered = new URL(callback.url);
    tampered.searchParams.set('state', 'foreign-state');
    const denied = await current.request(tampered.href);
    expect(denied.status).toBe(302);
    expect(new URL(denied.location!).searchParams.get('error')).toBe('OAuthCallback');
    expect(await db.select().from(users)).toEqual([]);
    const other = browser();
    const nextAuthorization = await other.start('apple');
    const nextCallback = await harness!.authorize(nextAuthorization, identity());
    for (const name of other.cookies.keys()) if (name.includes('pkce')) other.cookies.delete(name);
    const noVerifier = await other.request(nextCallback.url, { method: 'POST', form: nextCallback.form });
    expect(new URL(noVerifier.location!).searchParams.get('error')).toBe('OAuthCallback');
    expect(await db.select().from(users)).toEqual([]);
  });

  it('characterizes unknown invalid incoming session as anonymous instead of a protected actor', async () => {
    const current = browser();
    current.cookies.set('__Secure-next-auth.session-token', 'not-a-valid-jwe');
    const result = await current.complete('google', identity());
    expect(result.response.status).toBe(302);
    expect((await db.select().from(users)).length).toBe(1);
    expect((await current.claims())?.sub).toBeTruthy();
  });

  it.each(['google', 'apple'] as const)(
    'preserves actual %s Expo state-bound return and new-user metadata',
    async (provider) => {
      const current = browser();
      const destination = `${harness!.origin}/app/auth/register?boardseshOAuthProvider=${provider}&boardseshOAuthAttempt=owned-attempt-12345`;
      const completed = await current.complete(provider, identity(), {}, destination);
      expect(completed.response.status).toBe(302);
      expect(completed.response.location).toBe(destination);
      expect(
        completed.response.cookies.some(
          (cookie) => cookie.startsWith('boardsesh.oauth-return.') && /Max-Age=0/i.test(cookie),
        ),
      ).toBe(true);
      const claims = await current.claims();
      const receipt = claims?.nativeOAuthCreationProof as {
        authSessionId: string;
        provider: string;
        accountCreation: { userId: string; accountCreated: boolean; createdAt: string };
      };
      const owner = (await db.select().from(users))[0];
      expect(
        receipt.authSessionId === claims?.authSessionId &&
          receipt.provider === provider &&
          receipt.accountCreation.userId === owner.id &&
          receipt.accountCreation.accountCreated &&
          receipt.accountCreation.createdAt === owner.createdAt.toISOString(),
      ).toBe(true);
    },
  );

  it('returns only an allowlisted Expo OAuth failure without a session cookie after actual Apple cancellation', async () => {
    const current = browser();
    const destination = `${harness!.origin}/app/auth/login?boardseshOAuthProvider=apple&boardseshOAuthAttempt=owned-cancel-12345`;
    const completed = await current.complete('apple', identity(), { cancel: true }, destination);
    const returned = new URL(completed.response.location!);
    expect(returned.origin === harness!.origin && returned.pathname === '/app/auth/login').toBe(true);
    expect(returned.searchParams.get('boardseshOAuthError')).toBe('Callback');
    expect(returned.searchParams.get('boardseshOAuthAttempt')).toBe('owned-cancel-12345');
    expect(current.session().length).toBe(0);
    expect(await db.select().from(users)).toEqual([]);
  });

  it('forwards actual chunked session Set-Cookie arrays unchanged and reconstructs the same owner', async () => {
    const current = browser();
    const completed = await current.complete('google', { ...identity(), name: 'C'.repeat(3500) });
    expect(completed.response.status).toBe(302);
    const chunks = completed.response.cookies.filter((header) =>
      /^__Secure-next-auth\.session-token\.\d+=/.test(header),
    );
    expect(chunks.length).toBeGreaterThan(1);
    const owner = (await db.select().from(users))[0];
    expect((await current.claims())?.sub === owner.id).toBe(true);
    const snapshot = (await harness!.call('snapshot')) as { forwardedCookies: { preserved: boolean; count: number }[] };
    expect(snapshot.forwardedCookies.every((entry) => entry.preserved)).toBe(true);
  });
});
