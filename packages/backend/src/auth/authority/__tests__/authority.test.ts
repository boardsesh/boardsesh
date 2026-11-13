import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { compare, hash } from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  users,
  authAccount,
  authSession,
  authCredentialLineage,
  authSessionDenials,
  authMigrationEpochs,
} from '@boardsesh/db/schema';
import { createAuthorityAdapter } from '../adapter';
import { createAuthority } from '../authority';
import { configuration, createEnvironment } from './environment';

const password = ' café-山-🧗-password ';
const verifiedAt = new Date('2024-02-03T04:05:06.123Z');

describe('unmounted production authority over existing users', () => {
  let environment: Awaited<ReturnType<typeof createEnvironment>>;
  let passwordHash: string;
  beforeAll(async () => {
    environment = await createEnvironment();
    passwordHash = await hash(password, 4);
  });
  afterAll(async () => environment?.close());

  async function fixture(emailVerified: Date | null = null, name: string | null = null) {
    const id = randomUUID();
    const email = `climber-${id}@example.com`;
    await environment.database.insert(users).values({ id, email, name, emailVerified });
    await environment.database
      .insert(authAccount)
      .values({ id: randomUUID(), accountId: id, providerId: 'credential', userId: id, password: passwordHash });
    return { id, email };
  }

  async function storedUser(id: string) {
    const [user] = await environment.database.select().from(users).where(eq(users.id, id));
    return user;
  }

  it('signs in the same stable user with exact bcrypt bytes and a nullable name', async () => {
    const fixtureUser = await fixture();
    const response = await environment.withAuthority((auth) =>
      auth.api.signInEmail({ body: { email: fixtureUser.email, password } }),
    );
    expect(response.user).toMatchObject({ id: fixtureUser.id, name: '', emailVerified: false });
    const [session] = await environment.database
      .select()
      .from(authSession)
      .where(eq(authSession.userId, fixtureUser.id));
    expect(session.token).toBe(response.token);
    const [account] = await environment.database
      .select()
      .from(authAccount)
      .where(eq(authAccount.userId, fixtureUser.id));
    expect(account.password).toBe(passwordHash);
    expect(await compare(password, account.password!)).toBe(true);
    expect(await storedUser(fixtureUser.id)).toMatchObject({ name: null, emailVerified: null });
  });

  it('refuses wrong passwords without creating sessions or changing stored bcrypt bytes', async () => {
    const fixtureUser = await fixture();
    await expect(
      environment.withAuthority((auth) =>
        auth.api.signInEmail({ body: { email: fixtureUser.email, password: 'wrong-password' } }),
      ),
    ).rejects.toThrow();
    expect(
      await environment.database.select().from(authSession).where(eq(authSession.userId, fixtureUser.id)),
    ).toHaveLength(0);
    const [account] = await environment.database
      .select()
      .from(authAccount)
      .where(eq(authAccount.userId, fixtureUser.id));
    expect(account.password).toBe(passwordHash);
  });

  it('keeps verified timestamps byte-for-byte through sign-in and true updates', async () => {
    const fixtureUser = await fixture(verifiedAt);
    const response = await environment.withAuthority((auth) =>
      auth.api.signInEmail({ body: { email: fixtureUser.email, password } }),
    );
    expect(response.user.emailVerified).toBe(true);
    await environment.database.transaction(async (transaction) => {
      const adapter = createAuthorityAdapter(transaction)({});
      expect(
        await adapter.update({
          model: 'user',
          where: [{ field: 'id', value: fixtureUser.id }],
          update: { emailVerified: true },
        }),
      ).toMatchObject({ emailVerified: true });
    });
    expect((await storedUser(fixtureUser.id)).emailVerified).toEqual(verifiedAt);
  });

  it('maps false/true writes to NULL/timestamp without corrupting users', async () => {
    const fixtureUser = await fixture();
    await environment.database.transaction(async (transaction) => {
      const adapter = createAuthorityAdapter(transaction)({});
      expect(
        await adapter.update({
          model: 'user',
          where: [{ field: 'id', value: fixtureUser.id }],
          update: { emailVerified: false },
        }),
      ).toMatchObject({ emailVerified: false });
      expect((await transaction.select().from(users).where(eq(users.id, fixtureUser.id)))[0].emailVerified).toBeNull();
      expect(
        await adapter.update({
          model: 'user',
          where: [{ field: 'id', value: fixtureUser.id }],
          update: { emailVerified: true },
        }),
      ).toMatchObject({ emailVerified: true });
    });
    expect((await storedUser(fixtureUser.id)).emailVerified).toBeInstanceOf(Date);
  });

  it('creates an unverified user directly in users, without a second identity copy', async () => {
    const email = `signup-${randomUUID()}@example.com`;
    const response = await environment.withAuthority((auth) =>
      auth.api.signUpEmail({ body: { email, password, name: 'Climber' } }),
    );
    expect(response.user.emailVerified).toBe(false);
    expect(await storedUser(response.user.id)).toMatchObject({ email, emailVerified: null });
    const [tables] = await environment.client`SELECT to_regclass('auth_user') AS duplicate`;
    expect(tables.duplicate).toBeNull();
  });

  it('refuses mixed-case legacy rows until email normalization is complete', async () => {
    const fixtureUser = await fixture();
    await environment.database
      .update(users)
      .set({ email: fixtureUser.email.toUpperCase() })
      .where(eq(users.id, fixtureUser.id));
    await expect(
      environment.withAuthority((auth) => auth.api.signInEmail({ body: { email: fixtureUser.email, password } })),
    ).rejects.toThrow();
    await expect(
      environment.database.transaction(async (transaction) =>
        createAuthorityAdapter(transaction)({}).findOne({
          model: 'user',
          where: [{ field: 'id', value: fixtureUser.id }],
        }),
      ),
    ).rejects.toThrow('AUTHORITY_EMAIL_NORMALIZATION_REQUIRED');
    expect((await storedUser(fixtureUser.id)).email).toBe(fixtureUser.email.toUpperCase());
  });

  it('rolls back every BA write with the caller transaction, including adapter transactions', async () => {
    const fixtureUser = await fixture();
    await expect(
      environment.database.transaction(async (transaction) => {
        const auth = createAuthority(transaction, configuration);
        await auth.api.signInEmail({ body: { email: fixtureUser.email, password } });
        const adapter = createAuthorityAdapter(transaction)({});
        await adapter.transaction(async (bound) =>
          bound.update({
            model: 'user',
            where: [{ field: 'id', value: fixtureUser.id }],
            update: { name: 'Rollback me' },
          }),
        );
        throw new Error('injected-rollback');
      }),
    ).rejects.toThrow('injected-rollback');
    expect(await storedUser(fixtureUser.id)).toMatchObject({ name: null });
    expect(
      await environment.database.select().from(authSession).where(eq(authSession.userId, fixtureUser.id)),
    ).toHaveLength(0);
  });

  it('reads and signs out a canonical session without changing identity verification', async () => {
    const fixtureUser = await fixture(verifiedAt);
    const signedIn = await environment.withAuthority((auth) =>
      auth.api.signInEmail({ body: { email: fixtureUser.email, password }, returnHeaders: true }),
    );
    const cookie = signedIn.headers.get('set-cookie');
    expect(cookie).toBeTruthy();
    const headers = new Headers({ cookie: cookie!.split(';')[0] });
    const session = await environment.withAuthority((auth) => auth.api.getSession({ headers }));
    expect(session?.user).toMatchObject({ id: fixtureUser.id, emailVerified: true });
    await environment.withAuthority((auth) => auth.api.signOut({ headers }));
    expect(await environment.withAuthority((auth) => auth.api.getSession({ headers }))).toBeNull();
    expect((await storedUser(fixtureUser.id)).emailVerified).toEqual(verifiedAt);
  });

  it('rejects nonboolean writes before they can corrupt verification timestamps', async () => {
    const fixtureUser = await fixture(verifiedAt);
    await expect(
      environment.database.transaction(async (transaction) =>
        createAuthorityAdapter(transaction)({}).update({
          model: 'user',
          where: [{ field: 'id', value: fixtureUser.id }],
          update: { emailVerified: verifiedAt },
        }),
      ),
    ).rejects.toThrow('AUTHORITY_INVALID_VERIFICATION_BOOLEAN');
    expect((await storedUser(fixtureUser.id)).emailVerified).toEqual(verifiedAt);
  });

  it('translates boolean verification filters into timestamp nullability', async () => {
    const fixtureUser = await fixture();
    await environment.database.transaction(async (transaction) => {
      const adapter = createAuthorityAdapter(transaction)({});
      expect(
        await adapter.findOne({
          model: 'user',
          where: [
            { field: 'id', value: fixtureUser.id },
            { field: 'emailVerified', value: false },
          ],
        }),
      ).toMatchObject({ emailVerified: false });
      expect(
        await adapter.findOne({
          model: 'user',
          where: [
            { field: 'id', value: fixtureUser.id },
            { field: 'emailVerified', value: true },
          ],
        }),
      ).toBeNull();
    });
  });

  it('deletes account/session children while preserving independent revocation evidence', async () => {
    const fixtureUser = await fixture();
    await environment.withAuthority((auth) => auth.api.signInEmail({ body: { email: fixtureUser.email, password } }));
    const sessionId = randomUUID();
    const deadline = new Date(Date.now() + 60000);
    await environment.database
      .insert(authCredentialLineage)
      .values({ id: randomUUID(), userId: fixtureUser.id, sessionId, originalExpiresAt: deadline });
    await environment.database
      .insert(authSessionDenials)
      .values({ userId: fixtureUser.id, sessionId, expiresAt: deadline });
    const epochName = randomUUID();
    await environment.database.insert(authMigrationEpochs).values({ name: epochName, cutoverAt: new Date() });
    await environment.database.delete(users).where(eq(users.id, fixtureUser.id));
    expect(
      await environment.database.select().from(authAccount).where(eq(authAccount.userId, fixtureUser.id)),
    ).toHaveLength(0);
    expect(
      await environment.database.select().from(authSession).where(eq(authSession.userId, fixtureUser.id)),
    ).toHaveLength(0);
    expect(
      await environment.database
        .select()
        .from(authCredentialLineage)
        .where(eq(authCredentialLineage.userId, fixtureUser.id)),
    ).toHaveLength(1);
    expect(
      await environment.database.select().from(authSessionDenials).where(eq(authSessionDenials.userId, fixtureUser.id)),
    ).toHaveLength(1);
    expect(
      await environment.database.select().from(authMigrationEpochs).where(eq(authMigrationEpochs.name, epochName)),
    ).toHaveLength(1);
  });

  it('keeps boolean verification conversion inside adapter transaction callbacks', async () => {
    const fixtureUser = await fixture(verifiedAt);
    await environment.database.transaction(async (transaction) => {
      const adapter = createAuthorityAdapter(transaction)({});
      const response = await adapter.transaction((bound) =>
        bound.update({
          model: 'user',
          where: [{ field: 'id', value: fixtureUser.id }],
          update: { emailVerified: false },
        }),
      );
      expect(response).toMatchObject({ emailVerified: false });
    });
    expect((await storedUser(fixtureUser.id)).emailVerified).toBeNull();
  });

  it('refuses an expired canonical session without rewriting the user', async () => {
    const fixtureUser = await fixture(verifiedAt);
    const signedIn = await environment.withAuthority((auth) =>
      auth.api.signInEmail({
        body: { email: fixtureUser.email, password },
        returnHeaders: true,
      }),
    );
    const cookie = signedIn.headers.get('set-cookie');
    expect(cookie).toBeTruthy();
    await environment.database
      .update(authSession)
      .set({ expiresAt: new Date(Date.now() - 60000) })
      .where(eq(authSession.userId, fixtureUser.id));
    const headers = new Headers({ cookie: cookie!.split(';')[0] });
    expect(await environment.withAuthority((auth) => auth.api.getSession({ headers }))).toBeNull();
    expect((await storedUser(fixtureUser.id)).emailVerified).toEqual(verifiedAt);
  });

  it('constructs a transaction-bound instance within the 5 ms request budget', async () => {
    await environment.database.transaction(async (transaction) => {
      // Warm module/JIT setup is not per-request construction work.
      await createAuthority(transaction, configuration).$context;
      const start = performance.now();
      for (let iteration = 0; iteration < 100; iteration++) {
        await createAuthority(transaction, configuration).$context;
      }
      expect((performance.now() - start) / 100).toBeLessThan(5);
      await transaction.execute(sql`SELECT 1`);
    });
  });
});
