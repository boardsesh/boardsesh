import { createHash } from 'node:crypto';
import type { BrowserPasswordPreparation } from '@boardsesh/auth-protocol/browser-password-v1';
import type { WebCredentialProof } from '@boardsesh/auth-protocol';
import type { WebPasswordCandidate } from '../current-store/web-password';
import type { FirstPartyCredential, FirstPartySession } from './session-reader';
import type { IdentityAuthorityReceipt } from './router';

export const BROWSER_PASSWORD_RECEIPT_PREFIX = 'ba03-browser-password-v1:';
export const browserPasswordHash = (parts: readonly unknown[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const browserPasswordTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Same actual-byte domain as the browser intent's resultCredentialHash. */
export function browserPasswordCredentialHash(credential: FirstPartyCredential): string {
  return browserPasswordHash([
    'browser-selection-credential-v2',
    credential.kind,
    credential.kind === 'canonical-token' ? credential.token : credential.credential,
  ]);
}

/** Profile copy is not authentication state; password, email, verification and
 * deletion/generation state are. Only this digest crosses the private wire. */
export function browserPasswordStateHash(candidate: WebPasswordCandidate): string {
  return browserPasswordHash([
    'browser-password-credential-state-v1',
    candidate.userId,
    candidate.email,
    candidate.passwordHash,
    candidate.generation,
    candidate.deleted,
    candidate.emailVerified?.toISOString() ?? null,
  ]);
}

export function browserPasswordReceiptHash(
  operationToken: string,
  browserIntentToken: string,
  preparation: BrowserPasswordPreparation,
  state: 'prepared' | 'completed' | 'aborted',
  candidateHash?: string,
): string {
  return browserPasswordHash([
    'browser-password-receipt-v1',
    state,
    browserPasswordTokenHash(operationToken),
    browserPasswordTokenHash(browserIntentToken),
    preparation,
    candidateHash ?? null,
  ]);
}

export function browserPasswordProof(session: FirstPartySession): WebCredentialProof {
  return {
    version: 1,
    userId: session.userId,
    authSessionId: session.authSessionId,
    generation: session.generation,
    authenticatedAt: session.authenticatedAt?.toISOString() ?? null,
    linkGuarded: session.linkGuarded,
    ...(session.requiresAccountCutoff ? { requiresAccountCutoff: true as const } : {}),
  };
}

export function sameBrowserPasswordSession(
  session: FirstPartySession,
  proof: WebCredentialProof,
  expiresAt: string,
): boolean {
  return (
    session.userId === proof.userId &&
    session.authSessionId === proof.authSessionId &&
    session.generation === proof.generation &&
    (session.authenticatedAt?.toISOString() ?? null) === proof.authenticatedAt &&
    session.linkGuarded === proof.linkGuarded &&
    session.requiresAccountCutoff === (proof.requiresAccountCutoff === true) &&
    session.expiresAt.toISOString() === expiresAt
  );
}

export function sameBrowserPasswordAuthority(
  preparation: BrowserPasswordPreparation,
  authority: IdentityAuthorityReceipt,
): boolean {
  return (
    preparation.authority.projectionId === authority.projectionId &&
    preparation.authority.normalizerVersion === authority.normalizerVersion &&
    preparation.authority.authority === authority.authority &&
    preparation.authority.epoch === authority.epoch
  );
}
