import 'server-only';
import type { AnonymousProviderCommand } from '@boardsesh/auth-protocol';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { readBrowserCorrelationCookie, readBrowserProofCookie } from './browser-proof-cookies.server';
import { readPresentedBrowserSelection, type PresentedBrowserSelection } from './presented-browser-selection.server';
import {
  captureProviderBrowserContext,
  ProviderSecurityIdentityChangedError,
} from './provider-security-selection.server';
import { anonymousProviderFlowCookieName, openAnonymousProviderFlow } from './anonymous-provider-flow.server';
import { providerOwnedSigninNonceHash } from './provider-owned-signin-flow.server';
import { providerCandidateCredentialHash } from './provider-security-command-client.server';
import {
  createAnonymousProviderCommandClient,
  type AnonymousProviderCommandClient,
} from './anonymous-provider-command-client.server';
import { sameProviderSecurityCursor } from './provider-security-publication.server';

type Finalize = Extract<AnonymousProviderCommand, { operation: 'finalize' }>['payload'];
const changed = (): never => {
  throw new ProviderSecurityIdentityChangedError();
};

/** Readonly ACK input. Only the actual currently selected B proof supplies a
 * credential; the sealed preparation never reconstructs or recovers one. */
export async function readAnonymousProviderRecoveryInput(
  cookieHeader: string | null,
  flowHash: string,
  options: {
    readonly secret: string;
    readonly readSelection?: (cookies: string | null) => Promise<PresentedBrowserSelection>;
  },
) {
  const readSelection = options.readSelection ?? readPresentedBrowserSelection;
  const correlation = readBrowserCorrelationCookie(cookieHeader);
  if (correlation.status !== 'present') return changed();
  const name = anonymousProviderFlowCookieName(flowHash);
  const carriers = (cookieHeader ?? '')
    .split(';')
    .map((piece) => piece.trim())
    .filter((piece) => piece.startsWith(`${name}=`));
  if (carriers.length !== 1) return changed();
  const selected = await readSelection(cookieHeader);
  if (selected.status === 'unavailable') throw new AuthBackendUnavailableError();
  if (selected.status !== 'admitted') return changed();
  const current = captureProviderBrowserContext(selected);
  const flow = await openAnonymousProviderFlow(carriers[0].slice(name.length + 1), flowHash, options.secret);
  const target = flow.preparation;
  if (!target || !flow.preparationToken) return changed();
  const proof = target.credentialProof;
  const admitted = current.sourceCredentialProof;
  const candidate = readBrowserProofCookie(cookieHeader, {
    bindingId: current.browserCursor.bindingId,
    version: current.browserCursor.version,
  });
  if (
    correlation.token !== current.actor.browserBindingToken ||
    correlation.bindingId !== flow.browserBindingHash ||
    current.browserCursor.bindingId !== flow.browserBindingHash ||
    current.browserCursor.version !== flow.browserVersion + 1 ||
    current.browserCursor.bindingExpiresAt !== flow.browserBindingExpiresAt ||
    current.actor.kind !== flow.credentialKind ||
    current.credentialExpiresAt !== target.credentialExpiresAt ||
    admitted.userId !== proof.userId ||
    admitted.authSessionId !== proof.authSessionId ||
    admitted.generation !== proof.generation ||
    admitted.authenticatedAt !== proof.authenticatedAt ||
    admitted.linkGuarded !== proof.linkGuarded ||
    Boolean(admitted.requiresAccountCutoff) !== Boolean(proof.requiresAccountCutoff) ||
    candidate.status !== 'present' ||
    candidate.proof.kind !== current.actor.kind ||
    candidate.proof.rawCredential !== current.actor.credential ||
    (target.proposedCanonicalTokenHash !== null && current.credentialHash !== target.proposedCanonicalTokenHash)
  )
    return changed();
  const command: Finalize = {
    browser: { bindingToken: correlation.token, expectedVersion: flow.browserVersion },
    intentToken: flow.intentToken,
    browserIntentToken: flow.browserIntentToken,
    flowHash: flow.flowHash,
    nonceHash: providerOwnedSigninNonceHash(flow.nonce),
    ...(flow.nativeAttemptHash ? { nativeAttemptHash: flow.nativeAttemptHash } : {}),
    preparationToken: flow.preparationToken,
    preparation: target,
    candidate: { kind: candidate.proof.kind, credential: candidate.proof.rawCredential },
  };
  return Object.freeze({ command, browserCursor: current.browserCursor });
}

export function createAnonymousProviderAcknowledgment(options: {
  readonly secret: string;
  readonly readSelection?: (cookies: string | null) => Promise<PresentedBrowserSelection>;
  readonly clientFactory?: () => AnonymousProviderCommandClient;
}) {
  const secret = options.secret;
  const readSelection = options.readSelection ?? readPresentedBrowserSelection;
  const clientFactory = options.clientFactory ?? createAnonymousProviderCommandClient;
  return async (input: {
    readonly cookieHeader: string | null;
    readonly flowHash: string;
    readonly signal?: AbortSignal;
  }): Promise<'recovered' | 'identity_changed' | 'unavailable'> => {
    const cookieHeader = input.cookieHeader;
    const flowHash = input.flowHash;
    const signal = input.signal;
    try {
      if (signal?.aborted) return 'unavailable';
      const recovery = await readAnonymousProviderRecoveryInput(cookieHeader, flowHash, { secret, readSelection });
      if (signal?.aborted) return 'unavailable';
      const result = await clientFactory().command('finalize', recovery.command);
      if (
        signal?.aborted ||
        result.outcome !== 'recovered' ||
        result.candidateCredentialHash !== providerCandidateCredentialHash(recovery.command.candidate) ||
        !sameProviderSecurityCursor(result.browserCursor, recovery.browserCursor)
      )
        return 'unavailable';
      const after = await readAnonymousProviderRecoveryInput(cookieHeader, flowHash, { secret, readSelection });
      if (signal?.aborted || JSON.stringify(after) !== JSON.stringify(recovery)) return 'unavailable';
      return 'recovered';
    } catch (error) {
      return error instanceof ProviderSecurityIdentityChangedError ? 'identity_changed' : 'unavailable';
    }
  };
}
