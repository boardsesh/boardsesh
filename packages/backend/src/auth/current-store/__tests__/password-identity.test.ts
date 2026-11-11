import { randomUUID } from 'node:crypto';
import { IncomingMessage, type ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { compare, getRounds, hash } from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { mobileRefreshTokens, userCredentials, userProfiles, users } from '@boardsesh/db/schema/auth';
import { db } from '../../../db/client';
import { handleNativeAuthRegister, __resetNativeAuthStateForTests } from '../../../handlers/native-auth';
import {
  authenticateCurrentStorePassword,
  insertCurrentStorePasswordIdentity,
  matchCurrentStorePasswordCandidate,
  parseCurrentStorePasswordRegistration,
  prepareCurrentStorePasswordRegistration,
} from '../password-identity';

const comparedHashes = vi.hoisted(() => [] as string[]);
vi.mock('bcryptjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bcryptjs')>();
  return {
    ...actual,
    compare: (password: string, passwordHash: string) => {
      comparedHashes.push(passwordHash);
      return actual.compare(password, passwordHash);
    },
  };
});
beforeEach(() => {
  comparedHashes.length = 0;
});

function registration(email: string, password: string, name?: string) {
  const parsed = parseCurrentStorePasswordRegistration({ email, password, name });
  if (!parsed.ok) throw new Error('Invalid synthetic password registration fixture');
  return parsed.registration;
}

async function preparedRegistration(email: string, password: string, name?: string) {
  const prepared = await prepareCurrentStorePasswordRegistration(db, registration(email, password, name));
  if (!prepared) throw new Error('Synthetic registration unexpectedly already exists');
  return prepared;
}

async function identityRows(userId: string) {
  return {
    users: await db.select({ id: users.id }).from(users).where(eq(users.id, userId)),
    credentials: await db
      .select({ userId: userCredentials.userId })
      .from(userCredentials)
      .where(eq(userCredentials.userId, userId)),
    profiles: await db
      .select({ userId: userProfiles.userId })
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId)),
    refresh: await db
      .select({ userId: mobileRefreshTokens.userId })
      .from(mobileRefreshTokens)
      .where(eq(mobileRefreshTokens.userId, userId)),
  };
}

describe('comparison for an address with no password', () => {
  it('costs the same as a stored password on the shared comparison', async () => {
    const prepared = await preparedRegistration(`${randomUUID()}@example.test`, 'any-owned-password');
    expect(await matchCurrentStorePasswordCandidate([], 'submitted-password')).toBeNull();
    expect(comparedHashes).toHaveLength(1);
    expect(comparedHashes[0]).toHaveLength(60);
    expect(getRounds(comparedHashes[0])).toBe(getRounds(prepared.passwordHash));
  });

  // Native sign-in answered in 50 ms for an unknown address and 198 ms for a
  // wrong password while its stand-in hash was cost 10, which named the
  // addresses that have accounts. Both paths must run bcrypt at the stored cost.
  it('native login runs bcrypt at the stored cost whether or not the address has an account', async () => {
    const prepared = await preparedRegistration(`${randomUUID()}@example.test`, 'native-owned-password');
    await db.transaction((transaction) => insertCurrentStorePasswordIdentity(transaction, prepared, false));
    const storedCost = getRounds(prepared.passwordHash);
    comparedHashes.length = 0;

    expect(await authenticateCurrentStorePassword(db, `${randomUUID()}@example.test`, 'submitted')).toBeNull();
    expect(comparedHashes).toHaveLength(1);
    expect(getRounds(comparedHashes[0])).toBe(storedCost);

    comparedHashes.length = 0;
    expect(await authenticateCurrentStorePassword(db, prepared.email, 'wrong-password')).toBeNull();
    expect(comparedHashes).toEqual([prepared.passwordHash]);
    expect(getRounds(comparedHashes[0])).toBe(storedCost);
  });
});

describe('native password service over the current authoritative Postgres store', () => {
  it('preserves password bytes, bcrypt cost, native email/name preparation and profile defaults', async () => {
    const email = `Native.Mixed.${randomUUID()}+Tag@Example.test`;
    const password = '  café 山🧗\u0000 password  ';
    const prepared = await preparedRegistration(` ${email} `, password, '  Current Store Climber  ');
    expect(prepared.email).toBe(email.toLowerCase());
    expect(prepared.name).toBe('Current Store Climber');
    expect(getRounds(prepared.passwordHash)).toBe(12);
    expect(await compare(password, prepared.passwordHash)).toBe(true);
    expect(await compare(password.trim(), prepared.passwordHash)).toBe(false);
    expect('password' in prepared).toBe(false);
    const identity = await db.transaction((transaction) =>
      insertCurrentStorePasswordIdentity(transaction, prepared, false),
    );
    const [stored] = await db.select().from(users).where(eq(users.id, identity.userId));
    const [profile] = await db.select().from(userProfiles).where(eq(userProfiles.userId, identity.userId));
    expect(stored.email).toBe(email.toLowerCase());
    expect(stored.emailVerified).toBeInstanceOf(Date);
    expect(stored.createdAt).toEqual(identity.createdAt);
    expect(profile.isPrivate).toBe(false);
    // Also what bcrypt checked, for the issuer to compare again under its user lock.
    expect(await authenticateCurrentStorePassword(db, ` ${email.toUpperCase()} `, password)).toEqual({
      ...identity,
      passwordHash: prepared.passwordHash,
      generation: 0,
    });
    expect((await identityRows(identity.userId)).refresh).toEqual([]);
  });

  it('retains unverified native credential access when the verification flag is enabled', async () => {
    const prepared = await preparedRegistration(`${randomUUID()}@example.test`, 'unverified-native-password');
    const identity = await db.transaction((transaction) =>
      insertCurrentStorePasswordIdentity(transaction, prepared, true),
    );
    const [stored] = await db.select().from(users).where(eq(users.id, identity.userId));
    expect(stored.emailVerified).toBeNull();
    expect(await authenticateCurrentStorePassword(db, prepared.email, 'unverified-native-password')).toEqual({
      ...identity,
      passwordHash: prepared.passwordHash,
      generation: 0,
    });
  });

  it('authenticates an existing short password and treats SQL pattern characters literally', async () => {
    const id = randomUUID();
    const patternMatchId = randomUUID();
    const email = `Short_.%+${id}@Example.test`;
    const passwordHash = await hash('test', 4);
    // ILIKE would select this same-password neighbor as well as the literal
    // address, making the first authentication ambiguous instead of successful.
    await db.insert(users).values([
      { id, email, name: 'Existing short-password user' },
      { id: patternMatchId, email: email.replace('_.%', 'x.anything'), name: 'SQL pattern neighbor' },
    ]);
    await db.insert(userCredentials).values([
      { userId: id, passwordHash },
      { userId: patternMatchId, passwordHash },
    ]);
    const match = await authenticateCurrentStorePassword(db, email.toLowerCase(), 'test');
    expect(match?.userId).toBe(id);
    expect(await authenticateCurrentStorePassword(db, email.replace('_', 'x'), 'test')).toBeNull();
    expect(parseCurrentStorePasswordRegistration({ email, password: 'test' })).toEqual({
      ok: false,
      error: 'Password must be at least 8 characters',
    });
  });

  it('keeps duplicate-by-case owners separate and rejects a password shared by both owners', async () => {
    const firstId = randomUUID();
    const secondId = randomUUID();
    const email = `Collision.${firstId}@Example.test`;
    const firstHash = await hash('first-owner-password', 4);
    const secondHash = await hash('second-owner-password', 4);
    await db.insert(users).values([
      { id: firstId, email },
      { id: secondId, email: email.toLowerCase() },
    ]);
    await db.insert(userCredentials).values([
      { userId: firstId, passwordHash: firstHash },
      { userId: secondId, passwordHash: secondHash },
    ]);
    expect((await authenticateCurrentStorePassword(db, email, 'first-owner-password'))?.userId).toBe(firstId);
    expect((await authenticateCurrentStorePassword(db, email, 'second-owner-password'))?.userId).toBe(secondId);
    await db.update(userCredentials).set({ passwordHash: firstHash }).where(eq(userCredentials.userId, secondId));
    expect(await authenticateCurrentStorePassword(db, email, 'first-owner-password')).toBeNull();
  });

  it('preserves exact registration prechecks and does not silently trim existing stored addresses', async () => {
    const localPart = randomUUID();
    const existingEmail = `Existing.${localPart}@Example.test`;
    await db.insert(users).values({ id: randomUUID(), email: existingEmail });
    // Characterize the current gap honestly: reservation/final uniqueness is
    // later BA-03 work, not an incidental semantic change in this extraction.
    expect(
      await prepareCurrentStorePasswordRegistration(db, registration(existingEmail, 'registration-password')),
    ).not.toBeNull();
    const exactEmail = `${randomUUID()}@example.test`;
    await db.insert(users).values({ id: randomUUID(), email: exactEmail });
    expect(
      await prepareCurrentStorePasswordRegistration(db, registration(exactEmail, 'registration-password')),
    ).toBeNull();
    const paddedEmail = `${randomUUID()}@example.test`;
    const paddedId = randomUUID();
    await db.insert(users).values({ id: paddedId, email: ` ${paddedEmail} ` });
    await db.insert(userCredentials).values({ userId: paddedId, passwordHash: await hash('padded-password', 4) });
    expect(await authenticateCurrentStorePassword(db, paddedEmail, 'padded-password')).toBeNull();
  });

  it('rolls back user, credential, profile and actual refresh persistence after a post-write failure', async () => {
    const prepared = await preparedRegistration(`${randomUUID()}@example.test`, 'rollback-registration-password');
    let userId = '';
    let reachedRefreshWrite = false;
    await expect(
      db.transaction(async (transaction) => {
        const identity = await insertCurrentStorePasswordIdentity(transaction, prepared, false);
        userId = identity.userId;
        await transaction.insert(mobileRefreshTokens).values({
          userId,
          tokenHash: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
        });
        const persisted = await transaction
          .select()
          .from(mobileRefreshTokens)
          .where(eq(mobileRefreshTokens.userId, userId));
        expect(persisted).toHaveLength(1);
        reachedRefreshWrite = true;
        throw new Error('Synthetic failure after the current-store refresh write');
      }),
    ).rejects.toThrow('Synthetic failure after the current-store refresh write');
    expect(reachedRefreshWrite).toBe(true);
    expect(userId).not.toBe('');
    expect(await identityRows(userId)).toEqual({ users: [], credentials: [], profiles: [], refresh: [] });
  });

  it('the real native registration adapter rolls back identity writes when token signing cannot proceed', async () => {
    const email = `${randomUUID()}@example.test`;
    const previousSecret = process.env.NEXTAUTH_SECRET;
    const request = new IncomingMessage(new Socket());
    request.method = 'POST';
    request.url = '/auth/native/register';
    request.headers = {};
    const captured = {
      statusCode: 0,
      body: '',
      writeHead(status: number) {
        this.statusCode = status;
      },
      setHeader() {},
      end(body?: string) {
        this.body = body ?? '';
      },
    };
    __resetNativeAuthStateForTests();
    try {
      delete process.env.NEXTAUTH_SECRET;
      const registering = handleNativeAuthRegister(request, captured as unknown as ServerResponse);
      request.emit('data', Buffer.from(JSON.stringify({ email, password: 'missing-signing-key-password' })));
      request.emit('end');
      await registering;
      expect(captured.statusCode).toBe(503);
      expect(JSON.parse(captured.body)).toEqual({ error: 'Authentication is temporarily unavailable' });
      expect(await db.select({ id: users.id }).from(users).where(eq(users.email, email))).toEqual([]);
    } finally {
      if (previousSecret === undefined) delete process.env.NEXTAUTH_SECRET;
      else process.env.NEXTAUTH_SECRET = previousSecret;
      request.destroy();
    }
  });
});
