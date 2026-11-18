import { eq } from 'drizzle-orm';
import {
  WEB_CREDENTIAL_PROOF_VERSION,
  type PresentedWebSession,
  type WebCredentialProof,
} from '@boardsesh/auth-protocol';
import { authSessionDenials, userProfiles, users } from '@boardsesh/db/schema/auth';
import { AuthSubjectDeniedError, requireHumanSubjectForIssuance } from '../human-admission';
import { claimNativeTransferToken, transactionSettings } from '../current-store/command-context';
import { markTokenConsumed } from '../native-transfer-replay';
import { CurrentStoreFoundationError, type ExpectedCurrentStoreAuthority } from '../current-store/foundation-context';
import { readLockedWebSubjectState } from '../current-store/web-credential-state';
import { verifyNativeTransferToken } from '../native-transfer-token';
import type { AuthorityDatabase } from './adapter';
import { captureIdentityAuthority, revalidateIdentityAuthority } from './router';
import { readFirstPartySession, type FirstPartySession } from './session-reader';
import {
  issueWebSession,
  lockWebSessionAccounts,
  presentedWebCredential,
  type IssuedWebSession,
  type WebSessionUser,
} from './web-session';

/** The durable spent marker outlives the token's last accepted second. */
const SPENT_TRANSFER_RETENTION_MS = 5 * 60 * 1000;

export type WebSessionTransfer =
  | {
      readonly status: 'issued';
      readonly session: IssuedWebSession;
      readonly credentialProof: WebCredentialProof;
      readonly user: WebSessionUser;
    }
  | { readonly status: 'denied' }
  | { readonly status: 'sign-in-required' };

class TransferDenied extends Error {
  constructor() {
    super('Transfer denied');
    this.name = 'TransferDenied';
  }
}

/**
 * Signs a browser in with a native OAuth transfer token (#7596, B4c). The
 * sign-in happened in the app's browser, so the session is `carried`: it keeps
 * that sign-in's real time for the 30-day rules and never passes a five-minute
 * check. In one transaction, in the issuers' lock order (gate and manifest,
 * then `users` for the transferred and the presented account in one pass with
 * `lockWebSessionAccounts`): the account must exist at the token's generation,
 * the source login must not be signed out, the token is spent (single use),
 * the presented session is revoked, and the session is issued. No
 * reauthentication receipt is minted. The credential proof for the legacy twin
 * names the same session and generation and carries no sign-in time, so the
 * twin is never fresh either; a session is never issued without it.
 *
 * Throws when the session store or the authority cannot be read (503).
 */
export async function transferWebSession(
  database: AuthorityDatabase,
  input: { readonly transferToken: string; readonly presented?: PresentedWebSession },
  configured: ExpectedCurrentStoreAuthority,
  nextAuthSecret: string | undefined,
  now = new Date(),
): Promise<WebSessionTransfer> {
  const verified = verifyNativeTransferToken(input.transferToken);
  if (!verified) return { status: 'denied' };
  // A transfer without a verified sign-in time has nothing to carry.
  if (!verified.authenticatedAt) return { status: 'sign-in-required' };
  const signedInAt = new Date(Math.min(verified.authenticatedAt.getTime(), now.getTime()));
  // One spent marker across paths: the native exchange's replay store, keyed
  // on the recomputed signature. A token redeemed there is refused here, and
  // the reverse. The `verificationTokens` row below is the durable half.
  const consumed = await markTokenConsumed(verified.replayKey);
  if (consumed === 'replay') return { status: 'denied' };
  if (consumed === 'overloaded') throw new Error('Transfer replay store unavailable');
  const receipt = await database.transaction(async (transaction) => {
    await transactionSettings(transaction);
    return captureIdentityAuthority(transaction, {
      expectedProjectionId: configured.expectedProjectionId,
      expectedNormalizerVersion: configured.expectedNormalizerVersion,
    });
  });
  if (receipt.epoch !== configured.expectedWriterEpoch) throw new CurrentStoreFoundationError('STALE_AUTHORITY');
  try {
    return await database.transaction(async (transaction): Promise<WebSessionTransfer> => {
      await transactionSettings(transaction);
      const presented = input.presented
        ? await readPresented(transaction, input.presented, nextAuthSecret, now)
        : undefined;
      await revalidateIdentityAuthority(transaction, receipt);
      await lockWebSessionAccounts(transaction, eq(users.id, verified.userId), presented?.userId);
      const subject = await requireHumanSubjectForIssuance(transaction, verified.userId);
      if (Date.now() >= verified.validUntil || verified.generation !== subject.generation) throw new TransferDenied();
      if (verified.authSessionId) {
        const [denial] = await transaction
          .select({ sessionId: authSessionDenials.sessionId })
          .from(authSessionDenials)
          .where(eq(authSessionDenials.sessionId, verified.authSessionId));
        if (denial) throw new TransferDenied();
      }
      const spent = await claimNativeTransferToken(
        transaction,
        verified.replayKey,
        new Date(verified.validUntil + SPENT_TRANSFER_RETENTION_MS),
      );
      if (!spent) throw new TransferDenied();
      const session = await issueWebSession(transaction, {
        userId: verified.userId,
        authenticatedAt: signedInAt,
        freshness: 'carried',
        presented,
        now,
        authority: receipt,
      });
      const [account] = await transaction
        .select({
          email: users.email,
          name: users.name,
          image: users.image,
          displayName: userProfiles.displayName,
          avatarUrl: userProfiles.avatarUrl,
        })
        .from(users)
        .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
        .where(eq(users.id, verified.userId));
      if (!account) throw new AuthSubjectDeniedError();
      // As the native issuer does: the token must still be valid at the end.
      if (Date.now() >= verified.validUntil) throw new TransferDenied();
      return {
        status: 'issued',
        session,
        credentialProof: {
          version: WEB_CREDENTIAL_PROOF_VERSION,
          userId: verified.userId,
          authSessionId: session.sessionId,
          generation: session.generation,
          authenticatedAt: null,
          linkGuarded: false,
        },
        user: {
          id: verified.userId,
          email: account.email,
          name: account.displayName || account.name,
          image: account.avatarUrl || account.image,
        },
      };
    });
  } catch (error) {
    if (error instanceof TransferDenied || error instanceof AuthSubjectDeniedError) return { status: 'denied' };
    throw error;
  }
}

/** The session the request arrived with, read in this transaction, as a login reads it. */
async function readPresented(
  transaction: Parameters<Parameters<AuthorityDatabase['transaction']>[0]>[0],
  presented: PresentedWebSession,
  nextAuthSecret: string | undefined,
  now: Date,
): Promise<FirstPartySession | undefined> {
  const outcome = await readFirstPartySession(
    transaction,
    presentedWebCredential(presented, nextAuthSecret),
    now,
    (userId) => readLockedWebSubjectState(transaction, userId),
  );
  if (outcome.status === 'unavailable') throw new Error('Web session authority unavailable');
  return outcome.status === 'admitted' ? outcome.session : undefined;
}
