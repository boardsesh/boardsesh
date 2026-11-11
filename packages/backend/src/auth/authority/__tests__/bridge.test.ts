import { randomUUID } from 'node:crypto';
import { hkdf } from '@panva/hkdf';
import { EncryptJWT } from 'jose';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  users,
  authSession,
  authCredentialLineage,
  authSessionDenials,
  authSubjectCutoffs,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { bridgeLegacyCredential, legacyBridgeMode } from '../bridge';
import { readFirstPartySession, requireFreshAuthentication } from '../session-reader';
import { denyFirstPartySession } from '../lineage';

const secret = 'isolated-test-bridge-key-6975';
const now = new Date();
async function cookie(userId: string, authSessionId: string, generation?: number, authTime?: number) {
  const encryptionKey = await hkdf(
    'sha256',
    new TextEncoder().encode(secret),
    '',
    'NextAuth.js Generated Encryption Key',
    32,
  );
  return new EncryptJWT({
    authSessionId,
    ...(generation !== undefined ? { gen: generation } : {}),
    ...(authTime !== undefined ? { auth_time: authTime } : {}),
  })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setSubject(userId)
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(now.getTime() / 1000) + 3600)
    .encrypt(encryptionKey);
}

describe('production legacy bridge (dark)', () => {
  let environment: Awaited<ReturnType<typeof createEnvironment>>;
  beforeAll(async () => {
    environment = await createEnvironment();
  });
  afterAll(async () => environment?.close());
  async function fixture() {
    const userId = randomUUID();
    await environment.database.insert(users).values({ id: userId, email: `bridge-${userId}@example.com` });
    const authSessionId = randomUUID();
    return { userId, authSessionId, credential: await cookie(userId, authSessionId) };
  }
  it('defaults off and shadow creates no session or lineage', async () => {
    expect(legacyBridgeMode({})).toBe('off');
    expect(() => legacyBridgeMode({ AUTH_LEGACY_BRIDGE_MODE: 'true' })).toThrow();
    const fixtureSession = await fixture();
    expect(await bridgeLegacyCredential(environment.database, fixtureSession.credential, secret, 'off', now)).toEqual({
      status: 'off',
    });
    expect(
      await bridgeLegacyCredential(environment.database, fixtureSession.credential, secret, 'shadow', now),
    ).toEqual({ status: 'shadow' });
    expect(
      await environment.database.select().from(authSession).where(eq(authSession.id, fixtureSession.authSessionId)),
    ).toHaveLength(0);
  });
  it('bridges concurrently once, preserving public SID, signed expiry and unknown age', async () => {
    const fixtureSession = await fixture();
    const answers = await Promise.all(
      [1, 2].map(() => bridgeLegacyCredential(environment.database, fixtureSession.credential, secret, 'on', now)),
    );
    expect(answers.every((answer) => answer.status === 'bridged')).toBe(true);
    const [canonical] = await environment.database
      .select()
      .from(authSession)
      .where(eq(authSession.id, fixtureSession.authSessionId));
    expect(canonical.createdAt.getTime()).toBe(0);
    expect(canonical.originalAuthenticatedAt).toBeNull();
    expect(canonical.revocationGeneration).toBe(0);
    expect(canonical.expiresAt.getTime()).toBe((Math.floor(now.getTime() / 1000) + 3600) * 1000);
    expect(
      await environment.database
        .select()
        .from(authCredentialLineage)
        .where(eq(authCredentialLineage.userId, fixtureSession.userId)),
    ).toHaveLength(1);
    const readSubject = async () => ({ generation: 0, nativeGeneration: 7, deniedSessionKeys: new Set<string>() });
    const admitted = await readFirstPartySession(
      environment.database,
      { kind: 'canonical-token', token: canonical.token },
      now,
      readSubject,
    );
    expect(admitted.status).toBe('admitted');
    if (admitted.status === 'admitted') expect(requireFreshAuthentication(admitted.session, now)).toBe(false);
  });
  it('missing lineage does not deny a valid legacy session; an explicit denial does', async () => {
    const fixtureSession = await fixture();
    const credential = { kind: 'legacy-jwe' as const, credential: fixtureSession.credential, secret };
    const readSubject = async () => ({ generation: 0, nativeGeneration: 0, deniedSessionKeys: new Set<string>() });
    expect((await readFirstPartySession(environment.database, credential, now, readSubject)).status).toBe('admitted');
    await environment.database.insert(authSessionDenials).values({
      sessionId: fixtureSession.authSessionId,
      userId: fixtureSession.userId,
      expiresAt: new Date(now.getTime() + 3600000),
    });
    expect(
      (await bridgeLegacyCredential(environment.database, fixtureSession.credential, secret, 'on', now)).status,
    ).toBe('denied');
    expect(
      (
        await readFirstPartySession(environment.database, credential, now, async () => ({
          generation: 0,
          nativeGeneration: 0,
          deniedSessionKeys: new Set([fixtureSession.authSessionId]),
        }))
      ).status,
    ).toBe('denied');
  });
  it('never restamps an old proof and refuses a revoked lineage after restart', async () => {
    const fixtureSession = await fixture();
    await environment.database
      .insert(authSubjectCutoffs)
      .values({ userId: fixtureSession.userId, generation: 1, revokedThrough: now, lastOperationId: randomUUID() });
    expect(
      (await bridgeLegacyCredential(environment.database, fixtureSession.credential, secret, 'on', now)).status,
    ).toBe('denied');
    const current = await cookie(fixtureSession.userId, fixtureSession.authSessionId, 1);
    expect((await bridgeLegacyCredential(environment.database, current, secret, 'on', now)).status).toBe('bridged');
    await environment.database
      .update(authCredentialLineage)
      .set({ revokedAt: now })
      .where(eq(authCredentialLineage.userId, fixtureSession.userId));
    expect((await bridgeLegacyCredential(environment.database, current, secret, 'on', now)).status).toBe('denied');
  });
  it('a stale login denial preserves a newer login and persists without lineage', async () => {
    const fixtureSession = await fixture();
    const newerSessionId = randomUUID();
    const newerCredential = await cookie(fixtureSession.userId, newerSessionId);
    const first = await bridgeLegacyCredential(environment.database, fixtureSession.credential, secret, 'on', now);
    const newer = await bridgeLegacyCredential(environment.database, newerCredential, secret, 'on', now);
    expect(first.status).toBe('bridged');
    expect(newer.status).toBe('bridged');
    await denyFirstPartySession(
      environment.database,
      {
        userId: fixtureSession.userId,
        authSessionId: fixtureSession.authSessionId,
        generation: 0,
        requiresAccountCutoff: false,
        authenticatedAt: null,
        expiresAt: new Date(now.getTime() + 3600000),
      },
      now,
    );
    expect(
      (await bridgeLegacyCredential(environment.database, fixtureSession.credential, secret, 'on', now)).status,
    ).toBe('denied');
    expect((await bridgeLegacyCredential(environment.database, newerCredential, secret, 'on', now)).status).toBe(
      'bridged',
    );
    const [denial] = await environment.database
      .select()
      .from(authSessionDenials)
      .where(eq(authSessionDenials.sessionId, fixtureSession.authSessionId));
    expect(denial.expiresAt.getTime()).toBeGreaterThanOrEqual(now.getTime() + 30 * 86400000);
  });
  it('reports a primary outage separately and rejects canonical session IDs as tokens', async () => {
    const fixtureSession = await fixture();
    expect(
      await readFirstPartySession(
        environment.database,
        { kind: 'legacy-jwe', credential: fixtureSession.credential, secret },
        now,
        async () => {
          throw new Error('unavailable');
        },
      ),
    ).toEqual({ status: 'unavailable' });
    expect(
      await readFirstPartySession(
        environment.database,
        { kind: 'canonical-token', token: fixtureSession.authSessionId },
        now,
      ),
    ).toEqual({ status: 'denied' });
  });
});
