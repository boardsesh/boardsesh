import { randomUUID } from 'node:crypto';
import { hkdf } from '@panva/hkdf';
import { EncryptJWT } from 'jose';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { authSession, users } from '@boardsesh/db/schema';
import { createEnvironment, testBridgeTokenKey } from './environment';
import { bridgeLegacyCredential } from '../bridge';
import { readFirstPartySession } from '../session-reader';
import { bridgedSessionToken, bridgeTokenKey, newSessionToken, sessionTokenDigest } from '../session-token';

const secret = 'synthetic-session-token-digest-secret';
const now = new Date(Math.floor(Date.now() / 1000) * 1000);
let environment: Awaited<ReturnType<typeof createEnvironment>>;
vi.mock('../../admission-pool', () => ({
  readOnAdmissionConnection: async (
    mark: () => void,
    read: (database: typeof environment.database) => PromiseLike<unknown>,
  ) => {
    mark();
    return read(environment.database);
  },
}));
beforeAll(async () => {
  environment = await createEnvironment();
});
afterAll(async () => environment?.close());

async function account() {
  const userId = randomUUID();
  await environment.database.insert(users).values({ id: userId, email: `digest-${userId}@example.test` });
  return userId;
}
const read = (token: string) =>
  readFirstPartySession(environment.database, { kind: 'canonical-token', token }, now).then(({ status }) => status);

describe('session tokens at rest', () => {
  it('stores a SHA-256 digest that the reader finds from the raw token', async () => {
    const userId = await account();
    const { token, stored } = newSessionToken();
    expect(stored).toBe(sessionTokenDigest(token));
    expect(stored).not.toBe(token);
    expect(stored).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const id = randomUUID();
    await environment.database.insert(authSession).values({
      id,
      token: stored,
      userId,
      expiresAt: new Date(now.getTime() + 3_600_000),
      updatedAt: now,
      originalAuthenticatedAt: now,
      revocationGeneration: 0,
    });
    expect(await read(token)).toBe('admitted');
    // A copy of the column (a dump, a standby, a backup) is not a session.
    expect(await read(stored)).toBe('denied');
  });

  it('refuses a row that still holds a clear token', async () => {
    const userId = await account();
    const clear = randomUUID();
    await environment.database.insert(authSession).values({
      id: randomUUID(),
      token: clear,
      userId,
      expiresAt: new Date(now.getTime() + 3_600_000),
      updatedAt: now,
      originalAuthenticatedAt: now,
      revocationGeneration: 0,
    });
    expect(await read(clear)).toBe('denied');
  });

  it('a bridged row never stores the token it hands out', async () => {
    const userId = await account();
    const key = await hkdf('sha256', new TextEncoder().encode(secret), '', 'NextAuth.js Generated Encryption Key', 32);
    const cookie = await new EncryptJWT({ authSessionId: randomUUID() })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setSubject(userId)
      .setIssuedAt(now.getTime() / 1000)
      .setExpirationTime(now.getTime() / 1000 + 3600)
      .encrypt(key);
    const bridged = await bridgeLegacyCredential(environment.database, cookie, secret, testBridgeTokenKey, 'on', now);
    if (bridged.status !== 'bridged') throw new Error('Synthetic bridge refused');
    const [row] = await environment.database.select().from(authSession).where(eq(authSession.id, bridged.session.id));
    expect(row.token).toBe(sessionTokenDigest(bridged.token));
    expect(await read(bridged.token)).toBe('admitted');
    expect(await read(row.token)).toBe('denied');
    // A second bridge of the same login derives the same token again; the row is unchanged.
    const again = await bridgeLegacyCredential(environment.database, cookie, secret, testBridgeTokenKey, 'on', now);
    expect(again.status === 'bridged' && again.token).toBe(bridged.token);
    expect('token' in bridged.session).toBe(false);
    expect(
      (await environment.database.select().from(authSession).where(eq(authSession.id, bridged.session.id)))[0].token,
    ).toBe(row.token);
  });

  it('derives a bridged token from the session id under the bridge key alone', () => {
    const otherKey = bridgeTokenKey('another-synthetic-bridge-token-secret-0123456789');
    const first = bridgedSessionToken(testBridgeTokenKey, 'session-a');
    expect(bridgedSessionToken(testBridgeTokenKey, 'session-a')).toEqual(first);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.stored).toBe(sessionTokenDigest(first.token));
    expect(bridgedSessionToken(testBridgeTokenKey, 'session-b').token).not.toBe(first.token);
    expect(bridgedSessionToken(otherKey, 'session-a').token).not.toBe(first.token);
    // The key prints no bytes, and a short or padded secret is refused.
    expect(JSON.stringify(testBridgeTokenKey)).not.toMatch(/synthetic/);
    for (const weak of ['', 'short', ` ${'x'.repeat(40)}`]) expect(() => bridgeTokenKey(weak)).toThrow();
  });
});
