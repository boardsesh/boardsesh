import { replaceCanonicalAfterSecurityMutation } from '../authority/security-session';
import { hash } from 'bcryptjs';
import { and, eq, isNull } from 'drizzle-orm';
import { PASSWORD_HASH_COST } from '@boardsesh/auth-protocol/password-hash';
import {
  AUTH_PROTOCOL_VERSION,
  setPasswordMode,
  type SetPasswordCommand,
  type SetPasswordReply,
} from '@boardsesh/auth-protocol';
import { userCredentials, mobileRefreshTokens } from '@boardsesh/db/schema/auth';
import type { DbInstance } from '@boardsesh/db/client';
import { readFirstPartySession, requireFreshAuthentication } from '../authority/session-reader';
import {
  captureAuthority,
  transactionSettings,
  preflight,
  claimCommand,
  assertFresh,
  type WebPasswordAuthority,
} from './command-context';
import { lockEnforcedProjection, lockSubjectRow } from './foundation-context';
import { readLockedWebSubjectState } from './web-credential-state';
import { recordSecurityMutation } from './security-mutations';

/** Exact signed session proof, bcrypt outside locks, then same-transaction credential/cutoff/mirror. */
export async function setWebPassword(
  database: DbInstance,
  authorityInput: WebPasswordAuthority,
  input: SetPasswordCommand,
): Promise<SetPasswordReply> {
  if (setPasswordMode(process.env) !== 'backend-staging') throw new Error('Delegated set-password is disabled');
  const authority = captureAuthority(authorityInput);
  const { requestId, issuedAt } = input;
  const { credential, password, expectedUserId, expectedAuthSessionId } = input.payload;
  const base = { protocolVersion: AUTH_PROTOCOL_VERSION, operation: 'set-password', requestId } as const;
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('Web session authority unavailable');
  await preflight(database, authority);
  const presented = { kind: 'legacy-jwe' as const, credential, secret };
  const proof = await readFirstPartySession(database, presented);
  if (proof.status === 'unavailable') throw new Error('Web session authority unavailable');
  if (proof.status === 'denied') return { ...base, outcome: 'unauthenticated' };
  if (proof.session.userId !== expectedUserId || proof.session.authSessionId !== expectedAuthSessionId)
    return { ...base, outcome: 'identity_changed' };
  if (!requireFreshAuthentication(proof.session)) return { ...base, outcome: 'reauthentication_required' };
  const passwordHash = await hash(password, PASSWORD_HASH_COST);
  return database.transaction(async (transaction): Promise<SetPasswordReply> => {
    await transactionSettings(transaction);
    await lockEnforcedProjection(transaction, authority);
    await lockSubjectRow(transaction, proof.session.userId);
    const locked = await readFirstPartySession(transaction, presented, new Date(), (userId) =>
      readLockedWebSubjectState(transaction, userId),
    );
    if (locked.status === 'unavailable') throw new Error('Web session authority unavailable');
    if (
      locked.status !== 'admitted' ||
      locked.session.userId !== proof.session.userId ||
      locked.session.authSessionId !== proof.session.authSessionId ||
      locked.session.generation !== proof.session.generation
    )
      return { ...base, outcome: 'unauthenticated' };
    if (!requireFreshAuthentication(locked.session)) return { ...base, outcome: 'reauthentication_required' };
    if (!(await claimCommand(transaction, { operation: 'set-password', requestId, issuedAt })))
      return { ...base, outcome: 'error', code: 'replayed' };
    const [existing] = await transaction
      .select({ userId: userCredentials.userId })
      .from(userCredentials)
      .where(eq(userCredentials.userId, proof.session.userId))
      .for('update');
    if (existing) return { ...base, outcome: 'already_set' };
    await transaction.insert(userCredentials).values({ userId: proof.session.userId, passwordHash });
    const { cutoff } = await recordSecurityMutation(transaction, {
      ...authority,
      operationId: requestId,
      userId: proof.session.userId,
      expectedGeneration: proof.session.generation,
      kind: 'password-set',
      domains: ['first-party', 'partner'],
    });
    await replaceCanonicalAfterSecurityMutation(transaction, locked.session, cutoff.generation);
    await transaction
      .update(mobileRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(mobileRefreshTokens.userId, proof.session.userId), isNull(mobileRefreshTokens.revokedAt)));
    assertFresh(issuedAt);
    return {
      ...base,
      outcome: 'set',
      credentialProof: {
        version: 1,
        userId: locked.session.userId,
        authSessionId: locked.session.authSessionId,
        generation: cutoff.generation,
        authenticatedAt: locked.session.authenticatedAt?.toISOString() ?? null,
        linkGuarded: locked.session.linkGuarded,
      },
    };
  });
}
