import {
  keepCanonicalAfterSecurityMutation,
  replaceCanonicalAfterSecurityMutation,
} from '../authority/security-session';
import { hash } from 'bcryptjs';
import { and, eq, isNull } from 'drizzle-orm';
import { PASSWORD_HASH_COST } from '@boardsesh/auth-protocol/password-hash';
import {
  AUTH_PROTOCOL_VERSION,
  webSessionMode,
  setPasswordMode,
  providerSecurityMode,
  type SetPasswordCommand,
  type SetPasswordReply,
} from '@boardsesh/auth-protocol';
import { mobileRefreshTokens } from '@boardsesh/db/schema/auth';
import type { DbInstance } from '@boardsesh/db/client';
import {
  readFirstPartySession,
  requireFreshAuthentication,
  type FirstPartyCredential,
} from '../authority/session-reader';
import {
  captureAuthority,
  transactionSettings,
  claimCommand,
  assertFresh,
  type WebPasswordAuthority,
} from './command-context';
import { lockSubjectRow } from './foundation-context';
import { readLockedWebSubjectState } from './web-credential-state';
import { recordIdentityPasswordMutation } from '../authority/password-mutation';
import { captureIdentityAuthority, revalidateIdentityAuthority } from '../authority/router';
import { bindIdentityAuthority } from '../authority/identity-authority';

/**
 * Exact signed session proof, bcrypt outside locks, then same-transaction
 * credential/cutoff/mirror. The session is the legacy NextAuth cookie, or
 * (#7596, B4b, web session mode on) a canonical token, which must be a `login`
 * under five minutes old: a bridged or carried session answers
 * `reauthentication_required` and writes nothing. A canonical session keeps its
 * id and token; the reply carries the new generation and no token.
 */
export async function setWebPassword(
  database: DbInstance,
  authorityInput: WebPasswordAuthority,
  input: SetPasswordCommand,
): Promise<SetPasswordReply> {
  if (setPasswordMode(process.env) !== 'backend-staging') throw new Error('Delegated set-password is disabled');
  const configuredAuthority = captureAuthority(authorityInput);
  const { requestId, issuedAt } = input;
  const { password, expectedUserId, expectedAuthSessionId } = input.payload;
  // The first form and a presented legacy cookie are the same request.
  const legacyCredential =
    'credential' in input.payload
      ? input.payload.credential
      : input.payload.presented.kind === 'legacy-jwe'
        ? input.payload.presented.credential
        : undefined;
  const canonicalToken =
    'presented' in input.payload && input.payload.presented.kind === 'canonical-token'
      ? input.payload.presented.token
      : undefined;
  const base = { protocolVersion: AUTH_PROTOCOL_VERSION, operation: 'set-password', requestId } as const;
  // OAuth callback issuance time is not an actual reauthentication event. The
  // provider-security rollout cannot use this cookie-only bootstrap to create
  // a chosen password and then qualify that password as independent proof.
  // A separately qualified first-password ownership flow remains required.
  if (providerSecurityMode(process.env) === 'backend-staging') return { ...base, outcome: 'reauthentication_required' };
  // A canonical session is read only while the web session mode is on: dark otherwise.
  if (canonicalToken !== undefined && !webSessionModeOn()) return { ...base, outcome: 'unauthenticated' };
  const secret = process.env.NEXTAUTH_SECRET;
  if (legacyCredential !== undefined && !secret) throw new Error('Web session authority unavailable');
  const receipt = await database.transaction(async (transaction) => {
    await transactionSettings(transaction);
    return captureIdentityAuthority(transaction, configuredAuthority);
  });
  const authority = { ...configuredAuthority, expectedWriterEpoch: receipt.epoch };
  const presented: FirstPartyCredential =
    canonicalToken !== undefined
      ? { kind: 'canonical-token', token: canonicalToken }
      : { kind: 'legacy-jwe', credential: legacyCredential ?? '', secret: secret ?? '' };
  const proof = await readFirstPartySession(database, presented);
  if (proof.status === 'unavailable') throw new Error('Web session authority unavailable');
  if (proof.status === 'denied') return { ...base, outcome: 'unauthenticated' };
  if (proof.session.userId !== expectedUserId || proof.session.authSessionId !== expectedAuthSessionId)
    return { ...base, outcome: 'identity_changed' };
  if (!requireFreshAuthentication(proof.session)) return { ...base, outcome: 'reauthentication_required' };
  const passwordHash = await hash(password, PASSWORD_HASH_COST);
  return database.transaction(async (transaction): Promise<SetPasswordReply> => {
    await transactionSettings(transaction);
    await revalidateIdentityAuthority(transaction, receipt);
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
    const identity = bindIdentityAuthority(transaction, receipt);
    const existing = await identity.readPassword(proof.session.userId);
    if (existing) return { ...base, outcome: 'already_set' };
    await identity.insertPassword(proof.session.userId, passwordHash, proof.session.generation);
    const { cutoff } = await recordIdentityPasswordMutation(
      transaction,
      {
        ...authority,
        operationId: requestId,
        userId: proof.session.userId,
        expectedGeneration: proof.session.generation,
        kind: 'password-set',
        domains: ['first-party', 'partner'],
      },
      receipt,
    );
    // A canonical session keeps its id and token at the new generation (#7596,
    // B4b: only login and sign-out write the cookie). A legacy cookie's bridged
    // row, if any, is rotated as before.
    if (canonicalToken !== undefined)
      await keepCanonicalAfterSecurityMutation(transaction, locked.session, canonicalToken, cutoff.generation);
    else await replaceCanonicalAfterSecurityMutation(transaction, locked.session, cutoff.generation);
    await transaction
      .update(mobileRefreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(mobileRefreshTokens.userId, proof.session.userId), isNull(mobileRefreshTokens.revokedAt)));
    await revalidateIdentityAuthority(transaction, receipt);
    assertFresh(issuedAt);
    return {
      ...base,
      outcome: 'set',
      credentialProof: {
        version: 1,
        userId: locked.session.userId,
        authSessionId: locked.session.authSessionId,
        generation: cutoff.generation,
        // A kept canonical session writes no cookie, so its proof is only the
        // new generation: never fresh, in case a caller wrote a twin from it.
        authenticatedAt: canonicalToken !== undefined ? null : (locked.session.authenticatedAt?.toISOString() ?? null),
        linkGuarded: canonicalToken !== undefined ? false : locked.session.linkGuarded,
      },
    };
  });
}

/** Same reading as the web-session commands: an unknown value is off here. */
function webSessionModeOn(): boolean {
  try {
    return webSessionMode(process.env) === 'backend-staging';
  } catch {
    return false;
  }
}
