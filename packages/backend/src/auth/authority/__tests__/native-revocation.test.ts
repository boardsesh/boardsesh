import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  authSecurityMutationEvents,
  authSubjectCutoffs,
  mobileRefreshTokens,
  users,
  authSession,
  oauthClient,
  oauthRefreshToken,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { revokeNativeCredentials } from '../native-revocation';
import { decideCredential } from '../../credential-cutoffs';

describe('native-only revocation evidence and lock order', () => {
  let environment: Awaited<ReturnType<typeof createEnvironment>>;
  beforeAll(async () => {
    environment = await createEnvironment();
  });
  afterAll(async () => environment?.close());
  async function fixture() {
    const userId = randomUUID();
    const tokenHash = randomUUID();
    await environment.database.insert(users).values({ id: userId, email: `native-${userId}@example.com` });
    await environment.database
      .insert(mobileRefreshTokens)
      .values({ userId, tokenHash, expiresAt: new Date(Date.now() + 86400000) });
    return { userId, tokenHash };
  }
  it('ends native access/refresh while leaving web generation and canonical web sessions untouched', async () => {
    const subject = await fixture();
    const webSessionId = randomUUID();
    await environment.database.insert(authSession).values({
      id: webSessionId,
      userId: subject.userId,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 3600000),
      createdAt: new Date(0),
      updatedAt: new Date(),
      revocationGeneration: 0,
    });
    const clientId = randomUUID();
    const partnerTokenId = randomUUID();
    await environment.database
      .insert(oauthClient)
      .values({ id: clientId, clientId, redirectUris: ['https://partner.example.test/callback'] });
    await environment.database.insert(oauthRefreshToken).values({
      id: partnerTokenId,
      userId: subject.userId,
      clientId,
      token: randomUUID(),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      scopes: ['logbook:read'],
    });
    expect(await revokeNativeCredentials(environment.database, subject.tokenHash)).toBe(true);
    expect(
      (await environment.database.select().from(oauthRefreshToken).where(eq(oauthRefreshToken.id, partnerTokenId)))[0]
        .revoked,
    ).toBeNull();
    const [cutoff] = await environment.database
      .select()
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, subject.userId));
    expect(cutoff.generation).toBe(0);
    expect(cutoff.nativeGeneration).toBe(1);
    expect(cutoff.revokedThrough.getTime()).toBe(0);
    const state = {
      generation: cutoff.generation,
      nativeGeneration: cutoff.nativeGeneration,
      deniedSessionKeys: new Set<string>(),
    };
    expect(
      decideCredential(
        { kind: 'web-session', generationClaim: undefined, sessionKeyClaim: webSessionId, authTimeClaim: undefined },
        state,
        Date.now(),
      ).denial,
    ).toBeNull();
    expect(
      decideCredential(
        {
          kind: 'native-access',
          generationClaim: undefined,
          nativeGenerationClaim: undefined,
          authTimeClaim: undefined,
        },
        state,
        Date.now(),
      ).denial,
    ).toBe('native-generation');
    expect(
      decideCredential(
        { kind: 'native-refresh', subjectGeneration: null, nativeGeneration: null, authenticatedAt: null },
        state,
        Date.now(),
      ).denial,
    ).toBe('native-generation');
    expect(await environment.database.select().from(authSession).where(eq(authSession.id, webSessionId))).toHaveLength(
      1,
    );
    const [event] = await environment.database
      .select()
      .from(authSecurityMutationEvents)
      .where(eq(authSecurityMutationEvents.userId, subject.userId));
    expect(event).toMatchObject({
      kind: 'native-signout',
      generation: 0,
      previousGeneration: 0,
      nativeGeneration: 1,
      previousNativeGeneration: 0,
      domains: ['first-party'],
      writerEpoch: 0,
      projectionId: 'legacy-native',
    });
    expect(await revokeNativeCredentials(environment.database, subject.tokenHash)).toBe(false);
    expect(
      await environment.database
        .select()
        .from(authSecurityMutationEvents)
        .where(eq(authSecurityMutationEvents.userId, subject.userId)),
    ).toHaveLength(1);
  });
  it('records successive native generations without colliding with an account-wide mutation generation', async () => {
    const subject = await fixture();
    expect(await revokeNativeCredentials(environment.database, subject.tokenHash)).toBe(true);
    const nextTokenHash = randomUUID();
    await environment.database.insert(mobileRefreshTokens).values({
      userId: subject.userId,
      tokenHash: nextTokenHash,
      expiresAt: new Date(Date.now() + 86400000),
      nativeGeneration: 1,
      subjectGeneration: 0,
    });
    expect(await revokeNativeCredentials(environment.database, nextTokenHash)).toBe(true);
    await environment.database.insert(authSecurityMutationEvents).values({
      operationId: randomUUID(),
      userId: subject.userId,
      generation: 1,
      previousGeneration: 0,
      kind: 'admin-revocation',
      domains: ['first-party', 'partner'],
      writerEpoch: 1,
      projectionId: 'synthetic-projection',
      revokedThrough: new Date(),
    });
    expect(
      await environment.database
        .select()
        .from(authSecurityMutationEvents)
        .where(eq(authSecurityMutationEvents.userId, subject.userId)),
    ).toHaveLength(3);
  });
  it('keeps an existing account-wide cutoff time unchanged during native signout', async () => {
    const subject = await fixture();
    const accountCutoff = new Date(Date.now() - 600000);
    await environment.database.insert(authSubjectCutoffs).values({
      userId: subject.userId,
      generation: 1,
      nativeGeneration: 0,
      revokedThrough: accountCutoff,
      lastOperationId: randomUUID(),
    });
    await environment.database
      .update(mobileRefreshTokens)
      .set({ subjectGeneration: 1, nativeGeneration: 0 })
      .where(eq(mobileRefreshTokens.tokenHash, subject.tokenHash));
    expect(await revokeNativeCredentials(environment.database, subject.tokenHash)).toBe(true);
    const [cutoff] = await environment.database
      .select()
      .from(authSubjectCutoffs)
      .where(eq(authSubjectCutoffs.userId, subject.userId));
    expect(cutoff.generation).toBe(1);
    expect(cutoff.nativeGeneration).toBe(1);
    expect(cutoff.revokedThrough.getTime()).toBe(accountCutoff.getTime());
  });
  it('waits for a reset user lock before taking any refresh-row lock', async () => {
    const subject = await fixture();
    let releaseReset!: () => void;
    let resetLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      resetLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    const reset = environment.database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock_shared(6975, 2)`);
      await transaction.select().from(users).where(eq(users.id, subject.userId)).for('update');
      resetLocked();
      await release;
      await transaction
        .update(mobileRefreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(mobileRefreshTokens.userId, subject.userId));
    });
    await locked;
    const revocation = revokeNativeCredentials(environment.database, subject.tokenHash);
    // Observe the actual blocked user lock, then let reset take refresh rows.
    const observer = postgres(
      process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
      { max: 1 },
    );
    let userLockObserved = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const waiting =
        await observer`SELECT 1 FROM pg_stat_activity WHERE datname = ${environment.client.options.database} AND wait_event_type = 'Lock' AND query LIKE '%"users"%for update%'`;
      if (waiting.length) {
        userLockObserved = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    releaseReset();
    await observer.end({ timeout: 5 });
    await reset;
    expect(await revocation).toBe(false);
    expect(userLockObserved).toBe(true);
    expect(
      await environment.database
        .select()
        .from(authSecurityMutationEvents)
        .where(
          and(
            eq(authSecurityMutationEvents.userId, subject.userId),
            eq(authSecurityMutationEvents.kind, 'native-signout'),
          ),
        ),
    ).toHaveLength(0);
  });
});
