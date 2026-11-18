import type { BrowserBindingActor } from '@boardsesh/auth-protocol';
import type { AuthorityTransaction } from './adapter';
import { readBrowserBindingInTransaction, type BrowserBindingCursor } from './browser-binding';
import type { FirstPartyCredential, FirstPartySession } from './session-reader';
import { providerCredentialHash, presentedProviderCredential } from './provider-security-result';
import { ProviderSecurityRefusal } from './provider-security-context';
import type { IdentityAuthorityReceipt } from './router';

/**
 * The browser-binding actor of the owned-provider sign-in commands. Provider
 * link, unlink, reauthentication and first password no longer use it: they
 * read the first-party web session (`provider-security-context.ts`). This goes
 * with the binding core once #7596 B5a has moved its last callers.
 */
export interface CapturedBrowserBindingActor {
  readonly input: BrowserBindingActor;
  readonly credential: FirstPartyCredential;
  readonly credentialHash: string;
}

/** Capture every request and issuer primitive before authority reads or crypto awaits. */
export function captureBrowserBindingActor(
  actor: BrowserBindingActor,
  legacySecret: string | undefined,
): CapturedBrowserBindingActor {
  const input = Object.freeze({ ...actor });
  if (input.kind === 'legacy-jwe' && !legacySecret)
    throw new ProviderSecurityRefusal('unavailable', 'authority_unavailable');
  const credential: FirstPartyCredential =
    input.kind === 'legacy-jwe'
      ? Object.freeze({ kind: 'legacy-jwe', credential: input.credential, secret: legacySecret! })
      : Object.freeze({ kind: 'canonical-token', token: input.credential });
  return Object.freeze({
    input,
    credential,
    credentialHash: providerCredentialHash(presentedProviderCredential(credential)),
  });
}

export async function admitBrowserBindingActorInTransaction(
  transaction: AuthorityTransaction,
  authority: IdentityAuthorityReceipt,
  actor: CapturedBrowserBindingActor,
): Promise<{ readonly session: FirstPartySession; readonly cursor: BrowserBindingCursor }> {
  const admitted = await readBrowserBindingInTransaction(transaction, authority, {
    bindingToken: actor.input.browserBindingToken,
    actor: { version: actor.input.browserVersion, credential: actor.credential },
  });
  if (admitted.status === 'unavailable') throw new ProviderSecurityRefusal('unavailable', 'authority_unavailable');
  if (admitted.status !== 'admitted') throw new ProviderSecurityRefusal('unauthenticated', 'invalid_proof');
  if (
    admitted.session.userId !== actor.input.expectedUserId ||
    admitted.session.authSessionId !== actor.input.expectedAuthSessionId ||
    admitted.cursor.version !== actor.input.browserVersion
  )
    throw new ProviderSecurityRefusal('identity_changed', 'invalid_proof');
  return { session: admitted.session, cursor: admitted.cursor };
}
