import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  authSession,
  authCredentialLineage,
  authSubjectCutoffs,
  authSecurityMutationEvents,
  users,
} from '@boardsesh/db/schema';
import { createEnvironment } from './environment';
import { replaceCanonicalAfterSecurityMutation } from '../security-session';
import { readFirstPartySession } from '../session-reader';

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
      token: oldToken,
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
        { userId, authSessionId, generation: 0, requiresAccountCutoff: false, authenticatedAt: age, linkGuarded: true, expiresAt },
        1,
      );
    });
    expect(replacement?.token).not.toBe(oldToken);
    const [canonical] = await environment.database.select().from(authSession).where(eq(authSession.id, authSessionId));
    expect(canonical.revocationGeneration).toBe(1);
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
