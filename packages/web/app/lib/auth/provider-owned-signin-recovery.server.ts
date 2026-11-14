import 'server-only';
import { providerSecurityMode, type ProviderSecurityCommand } from '@boardsesh/auth-protocol';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import type { AuthServiceEnvironment } from '@boardsesh/auth-protocol/transport';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { readBrowserCorrelationCookie, readBrowserProofCookie } from './browser-proof-cookies.server';
import { readPresentedBrowserSelection, type PresentedBrowserSelection } from './presented-browser-selection.server';
import {
  openProviderOwnedSigninFlow,
  providerOwnedSigninCookieName,
  providerOwnedSigninNonceHash,
} from './provider-owned-signin-flow.server';
import {
  createProviderSecurityCommandClient,
  providerCandidateCredentialHash,
  type ProviderSecurityCommandClient,
} from './provider-security-command-client.server';
import { sameProviderSecurityCursor } from './provider-security-publication.server';
import { publicProviderSecurityReady } from './provider-security-readiness';
import {
  captureProviderBrowserContext,
  ProviderSecurityIdentityChangedError,
  type ProviderBrowserContext,
} from './provider-security-selection.server';

type RecoveryInput = Extract<ProviderSecurityCommand, { operation: 'signin-finalize' }>['payload'];
interface ProviderOwnedSigninRecovery {
  readonly command: Readonly<RecoveryInput>;
  readonly browserCursor: ProviderBrowserContext['browserCursor'];
}
function changed(): never {
  throw new ProviderSecurityIdentityChangedError();
}

/** ACK only. Both A and B must arrive as actual versioned proof cookies; the
 * sealed preparation never supplies, recreates or substitutes a credential. */
export async function readProviderOwnedSigninRecoveryInput(
  cookieHeader: string | null,
  flowHash: string,
  options: {
    readonly secret: string;
    readonly readSelection?: (cookies: string | null) => Promise<PresentedBrowserSelection>;
  },
): Promise<ProviderOwnedSigninRecovery> {
  const secret = options.secret;
  const readSelection = options.readSelection ?? readPresentedBrowserSelection;
  const correlation = readBrowserCorrelationCookie(cookieHeader);
  if (correlation.status !== 'present') return changed();
  const name = providerOwnedSigninCookieName(flowHash);
  const carriers = (cookieHeader ?? '')
    .split(';')
    .map((piece) => piece.trim())
    .filter((piece) => piece.startsWith(`${name}=`));
  if (carriers.length !== 1) return changed();
  const sealed = carriers[0].slice(name.length + 1);
  const selected = await readSelection(cookieHeader);
  if (selected.status === 'unavailable') throw new AuthBackendUnavailableError();
  if (selected.status !== 'admitted') return changed();
  const current = captureProviderBrowserContext(selected);
  const flow = await openProviderOwnedSigninFlow(sealed, flowHash, secret);
  const preparation = flow.preparation;
  if (!preparation || !flow.preparationToken) return changed();
  const target = preparation.credentialProof;
  const admitted = current.sourceCredentialProof;
  if (
    correlation.token !== current.actor.browserBindingToken ||
    correlation.bindingId !== flow.browserBindingHash ||
    current.browserCursor.bindingId !== flow.browserBindingHash ||
    current.browserCursor.version !== flow.browserVersion + 1 ||
    current.browserCursor.bindingExpiresAt !== flow.browserBindingExpiresAt ||
    current.actor.kind !== flow.actorKind ||
    current.credentialExpiresAt !== preparation.credentialExpiresAt ||
    admitted.userId !== target.userId ||
    admitted.authSessionId !== target.authSessionId ||
    admitted.generation !== target.generation ||
    admitted.authenticatedAt !== target.authenticatedAt ||
    admitted.linkGuarded !== target.linkGuarded ||
    Boolean(admitted.requiresAccountCutoff) !== Boolean(target.requiresAccountCutoff)
  )
    return changed();
  const previous = readBrowserProofCookie(cookieHeader, {
    bindingId: flow.browserBindingHash,
    version: flow.browserVersion,
  });
  const candidate = readBrowserProofCookie(cookieHeader, {
    bindingId: current.browserCursor.bindingId,
    version: current.browserCursor.version,
  });
  if (
    previous.status !== 'present' ||
    candidate.status !== 'present' ||
    previous.proof.kind !== flow.actorKind ||
    candidate.proof.kind !== current.actor.kind ||
    candidate.proof.rawCredential !== current.actor.credential ||
    providerCandidateCredentialHash({ kind: previous.proof.kind, credential: previous.proof.rawCredential }) !==
      flow.actorCredentialHash ||
    current.credentialHash === flow.actorCredentialHash ||
    (preparation.proposedCanonicalTokenHash !== null &&
      current.credentialHash !== preparation.proposedCanonicalTokenHash)
  )
    return changed();
  return Object.freeze({
    browserCursor: current.browserCursor,
    command: Object.freeze({
      actor: Object.freeze({
        kind: previous.proof.kind,
        credential: previous.proof.rawCredential,
        expectedUserId: flow.sourceCredentialProof.userId,
        expectedAuthSessionId: flow.sourceCredentialProof.authSessionId,
        browserBindingToken: correlation.token,
        browserVersion: flow.browserVersion,
      }),
      intentToken: flow.intentToken,
      browserIntentToken: flow.browserIntentToken,
      flowHash: flow.flowHash,
      nonceHash: providerOwnedSigninNonceHash(flow.nonce),
      preparationToken: flow.preparationToken,
      preparation,
      candidate: Object.freeze({ kind: candidate.proof.kind, credential: candidate.proof.rawCredential }),
    }),
  });
}

function reply(outcome: 'recovered' | 'identity_changed' | 'unavailable', status: number): Response {
  return Response.json(
    { outcome },
    {
      status,
      headers: {
        'Cache-Control': 'private, no-store',
        Pragma: 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        ...(status === 503 ? { 'Retry-After': '1' } : {}),
      },
    },
  );
}

/** The eventual route must first enforce canonical Host/Origin and body bounds.
 * This read-only receipt publisher has no cookie writes or mutation retries. */
export function createProviderOwnedSigninAcknowledgment(
  options: {
    readonly environment?: AuthServiceEnvironment;
    readonly ready?: () => boolean;
    readonly readSelection?: (cookies: string | null) => Promise<PresentedBrowserSelection>;
    readonly clientFactory?: () => ProviderSecurityCommandClient;
  } = {},
) {
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  const ready = options.ready ?? publicProviderSecurityReady;
  const readSelection = options.readSelection ?? ((cookies) => readPresentedBrowserSelection(cookies, { environment }));
  const clientFactory = options.clientFactory ?? (() => createProviderSecurityCommandClient({ environment }));
  return async (input: {
    readonly cookieHeader: string | null;
    readonly flowHash: string;
    readonly signal?: AbortSignal;
  }): Promise<Response> => {
    const cookieHeader = input.cookieHeader;
    const flowHash = input.flowHash;
    const signal = input.signal;
    try {
      if (
        !ready() ||
        providerSecurityMode(environment) !== 'backend-staging' ||
        browserBindingMode(environment) !== 'backend-staging' ||
        signal?.aborted
      )
        return reply('unavailable', 503);
      const recovery = await readProviderOwnedSigninRecoveryInput(cookieHeader, flowHash, {
        secret: environment.NEXTAUTH_SECRET ?? '',
        readSelection,
      });
      if (signal?.aborted) return reply('unavailable', 503);
      const result = await clientFactory().command('signin-finalize', recovery.command);
      if (
        signal?.aborted ||
        result.outcome !== 'recovered' ||
        result.candidateCredentialHash !== providerCandidateCredentialHash(recovery.command.candidate) ||
        !sameProviderSecurityCursor(result.browserCursor, recovery.browserCursor)
      )
        return reply('unavailable', 503);
      const after = await readProviderOwnedSigninRecoveryInput(cookieHeader, flowHash, {
        secret: environment.NEXTAUTH_SECRET ?? '',
        readSelection,
      });
      if (signal?.aborted || JSON.stringify(after) !== JSON.stringify(recovery)) return reply('unavailable', 503);
      return reply('recovered', 200);
    } catch (error) {
      return error instanceof ProviderSecurityIdentityChangedError
        ? reply('identity_changed', 409)
        : reply('unavailable', 503);
    }
  };
}
