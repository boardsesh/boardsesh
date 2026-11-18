import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  authSession,
  authCredentialLineage,
  authSubjectCutoffs,
  authSecurityMutationEvents,
  authSessionDenials,
  users,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { keepCanonicalAfterSecurityMutation, replaceCanonicalAfterSecurityMutation } from '../security-session';
import { readFirstPartySession, type FirstPartySession } from '../session-reader';
import { sessionTokenDigest } from '../session-token';

describe('post-mutation canonical replacement and event constraints', () => {
  let environment: Awaited<ReturnType<typeof createEnvironment>>;
  beforeAll(async () => {
    environment = await createEnvironment();
  });
  afterAll(async () => environment?.close());
  it('rotates the opaque token without changing public SID, source age or expiry', async () => {
    const userId = randomUUID();
    const authSessionId = randomUUID();
    const oldToken = randomUUID();
    const age = new Date(Date.now() - 120000);
    const expiresAt = new Date(Date.now() + 3600000);
    await environment.database.insert(users).values({ id: userId, email: `replace-${userId}@example.com` });
    await environment.database.insert(authSession).values({
      id: authSessionId,
      token: sessionTokenDigest(oldToken),
      userId,
      expiresAt,
      createdAt: age,
      updatedAt: age,
      originalAuthenticatedAt: age,
      revocationGeneration: 0,
      legacyLineageId: `session:${authSessionId}`,
    });
    await environment.database.insert(authCredentialLineage).values({
      id: `session:${authSessionId}`,
      userId,
      sessionId: authSessionId,
      originalAuthenticatedAt: age,
      originalExpiresAt: expiresAt,
    });
    const replacement = await environment.database.transaction(async (transaction) => {
      await transaction.execute(sql`SELECT pg_advisory_xact_lock_shared(6975, 2)`);
      await transaction.select().from(users).where(eq(users.id, userId)).for('update');
      await transaction
        .insert(authSubjectCutoffs)
        .values({ userId, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() });
      return replaceCanonicalAfterSecurityMutation(
        transaction,
        {
          userId,
          authSessionId,
          generation: 0,
          requiresAccountCutoff: false,
          authenticatedAt: age,
          linkGuarded: true,
          expiresAt,
        },
        1,
      );
    });
    expect(replacement?.token).not.toBe(oldToken);
    const [canonical] = await environment.database.select().from(authSession).where(eq(authSession.id, authSessionId));
    expect(canonical.revocationGeneration).toBe(1);
    // The row holds the new token's digest, never the token.
    expect(canonical.token).toBe(sessionTokenDigest(replacement!.token));
    expect(canonical.createdAt.getTime()).toBe(age.getTime());
    expect(canonical.originalAuthenticatedAt?.getTime()).toBe(age.getTime());
    expect(canonical.expiresAt.getTime()).toBe(expiresAt.getTime());
    const readSubject = async () => ({ generation: 1, nativeGeneration: 0, deniedSessionKeys: new Set<string>() });
    expect(
      await readFirstPartySession(
        environment.database,
        { kind: 'canonical-token', token: oldToken },
        new Date(),
        readSubject,
      ),
    ).toEqual({ status: 'denied' });
    expect(
      (
        await readFirstPartySession(
          environment.database,
          { kind: 'canonical-token', token: replacement!.token },
          new Date(),
          readSubject,
        )
      ).status,
    ).toBe('admitted');
  });
  async function keptSession() {
    const userId = randomUUID();
    const authSessionId = randomUUID();
    const token = randomUUID();
    const age = new Date(Date.now() - 120000);
    const expiresAt = new Date(Date.now() + 3600000);
    await environment.database.insert(users).values({ id: userId, email: `keep-${userId}@example.com` });
    await environment.database.insert(authSession).values({
      id: authSessionId,
      token: sessionTokenDigest(token),
      userId,
      expiresAt,
      createdAt: age,
      updatedAt: age,
      originalAuthenticatedAt: age,
      revocationGeneration: 0,
    });
    const actor: FirstPartySession = {
      userId,
      authSessionId,
      generation: 0,
      requiresAccountCutoff: false,
      authenticatedAt: age,
      linkGuarded: true,
      expiresAt,
      source: 'login',
    };
    const keep = (presented: string, generation = 1) =>
      environment.database.transaction(async (transaction) => {
        await transaction.select().from(users).where(eq(users.id, userId)).for('update');
        await transaction
          .insert(authSubjectCutoffs)
          .values({ userId, generation: 1, revokedThrough: new Date(), lastOperationId: randomUUID() });
        await keepCanonicalAfterSecurityMutation(transaction, actor, presented, generation);
      });
    return { userId, authSessionId, token, age, expiresAt, keep };
  }
  it('in place: keeps the id, token, sign-in time and expiry and moves only the generation', async () => {
    const kept = await keptSession();
    const [before] = await environment.database
      .select()
      .from(authSession)
      .where(eq(authSession.id, kept.authSessionId));
    await kept.keep(kept.token);
    const [after] = await environment.database.select().from(authSession).where(eq(authSession.id, kept.authSessionId));
    expect(after).toEqual({ ...before, revocationGeneration: 1, updatedAt: after.updatedAt });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    const readSubject = async () => ({ generation: 1, nativeGeneration: 0, deniedSessionKeys: new Set<string>() });
    expect(
      await readFirstPartySession(
        environment.database,
        { kind: 'canonical-token', token: kept.token },
        new Date(),
        readSubject,
      ),
    ).toMatchObject({
      status: 'admitted',
      session: {
        authSessionId: kept.authSessionId,
        generation: 1,
        authenticatedAt: kept.age,
        expiresAt: kept.expiresAt,
      },
    });
  });
  it('in place: refuses another token, a skipped generation, a denied row and a moved sign-in time, writing nothing', async () => {
    const kept = await keptSession();
    const [before] = await environment.database
      .select()
      .from(authSession)
      .where(eq(authSession.id, kept.authSessionId));
    await expect(kept.keep(randomUUID())).rejects.toThrow('SESSION_CONTINUATION_SOURCE_MISMATCH');
    await expect(kept.keep(kept.token, 2)).rejects.toThrow('SESSION_CONTINUATION_GENERATION_MISMATCH');
    await environment.database
      .update(authSession)
      .set({ originalAuthenticatedAt: new Date() })
      .where(eq(authSession.id, kept.authSessionId));
    await expect(kept.keep(kept.token)).rejects.toThrow('SESSION_CONTINUATION_SOURCE_MISMATCH');
    await environment.database
      .update(authSession)
      .set({ originalAuthenticatedAt: kept.age })
      .where(eq(authSession.id, kept.authSessionId));
    await environment.database
      .insert(authSessionDenials)
      .values({ sessionId: kept.authSessionId, userId: kept.userId, expiresAt: kept.expiresAt });
    await expect(kept.keep(kept.token)).rejects.toThrow('SESSION_CONTINUATION_DENIED');
    // updatedAt moved only with this test's own direct writes above.
    expect(
      (await environment.database.select().from(authSession).where(eq(authSession.id, kept.authSessionId)))[0],
    ).toEqual({ ...before, updatedAt: expect.any(Date) });
    expect(
      await environment.database.select().from(authSubjectCutoffs).where(eq(authSubjectCutoffs.userId, kept.userId)),
    ).toHaveLength(0);
  });
  it.each(['legacy-signout', 'native-signout', 'admin-revocation', 'password-reset'] as const)(
    'retains migrated domain and epoch constraints for %s',
    async (kind) => {
      const isNative = kind === 'native-signout';
      const firstPartyOnly = isNative || kind === 'legacy-signout';
      const event = {
        operationId: randomUUID(),
        userId: randomUUID(),
        generation: isNative ? 0 : 1,
        previousGeneration: 0,
        kind,
        domains: firstPartyOnly
          ? (['first-party'] as ['first-party'])
          : (['first-party', 'partner'] as ['first-party', 'partner']),
        revokedThrough: new Date(),
        writerEpoch: isNative ? 0 : 2,
        projectionId: isNative ? 'legacy-native' : 'enforced-fixture',
        nativeGeneration: isNative ? 1 : null,
        previousNativeGeneration: isNative ? 0 : null,
      };
      await environment.database.insert(authSecurityMutationEvents).values(event);
      const invalidDomain = firstPartyOnly
        ? (['first-party', 'partner'] as ['first-party', 'partner'])
        : (['first-party'] as ['first-party']);
      for (const mutation of [
        { domains: invalidDomain },
        isNative ? { projectionId: 'unqualified-legacy' } : { writerEpoch: 0, projectionId: 'legacy-native' },
        ...(isNative ? [] : [{ nativeGeneration: 1, previousNativeGeneration: 0 }]),
      ]) {
        await expect(
          environment.database.insert(authSecurityMutationEvents).values({
            ...event,
            operationId: randomUUID(),
            userId: randomUUID(),
            ...mutation,
          }),
        ).rejects.toThrow();
      }
    },
  );

  it('rejects native events with missing stamps, changed web generation, or partner domains', async () => {
    const valid = {
      operationId: randomUUID(),
      userId: randomUUID(),
      generation: 0,
      previousGeneration: 0,
      kind: 'native-signout' as const,
      domains: ['first-party'] as ['first-party'],
      revokedThrough: new Date(),
      writerEpoch: 0,
      projectionId: 'legacy-native',
      nativeGeneration: 1,
      previousNativeGeneration: 0,
    };
    for (const mutation of [
      { nativeGeneration: null },
      { previousNativeGeneration: null },
      { generation: 1 },
      { domains: ['first-party', 'partner'] as ['first-party', 'partner'] },
    ]) {
      await expect(
        environment.database
          .insert(authSecurityMutationEvents)
          .values({ ...valid, operationId: randomUUID(), ...mutation }),
      ).rejects.toThrow();
    }
    await environment.database.insert(authSecurityMutationEvents).values(valid);
    expect(
      await environment.database
        .select()
        .from(authSecurityMutationEvents)
        .where(eq(authSecurityMutationEvents.operationId, valid.operationId)),
    ).toHaveLength(1);
  });
});
