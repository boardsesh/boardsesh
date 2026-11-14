import 'server-only';
import type { ProviderSecurityCommand } from '@boardsesh/auth-protocol';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { readPresentedBrowserSelection, type PresentedBrowserSelection } from './presented-browser-selection.server';
import { readBrowserCorrelationCookie, readBrowserProofCookie } from './browser-proof-cookies.server';
import { providerCandidateCredentialHash } from './provider-security-command-client.server';
import { openProviderSecurityFlow, providerSecurityFlowCookieName } from './provider-security-flow.server';
import {
  captureProviderBrowserContext,
  ProviderSecurityIdentityChangedError,
} from './provider-security-selection.server';

type RecoveryInput = Extract<ProviderSecurityCommand, { operation: 'recover' }>['payload'];
function changed(): never {
  throw new ProviderSecurityIdentityChangedError();
}

/** Read-only ACK input from the next real request. The sealed carrier contains
 * metadata/capabilities only: BOTH old actor and current candidate must still
 * arrive as actual version-named proof cookies. No SID lookup returns a bearer. */
export async function readProviderSecurityRecoveryInput(
  cookieHeader: string | null,
  operationKey: string,
  options: {
    readonly secret: string;
    readonly readSelection?: (cookies: string | null) => Promise<PresentedBrowserSelection>;
    readonly clock?: () => Date;
  },
): Promise<Readonly<RecoveryInput>> {
  const secret = options.secret;
  const clock = options.clock ?? (() => new Date());
  const readSelection = options.readSelection ?? readPresentedBrowserSelection;
  // This codec also bounds the entire observed header/pair count and rejects
  // malformed/ambiguous correlation. Never hide cookies to make capacity fit.
  const correlation = readBrowserCorrelationCookie(cookieHeader);
  if (correlation.status !== 'present') return changed();
  const name = providerSecurityFlowCookieName(operationKey, true);
  const carriers = (cookieHeader ?? '')
    .split(';')
    .map((piece) => piece.trim())
    .filter((piece) => piece.startsWith(`${name}=`));
  if (carriers.length !== 1) return changed();
  const sealed = carriers[0].slice(name.length + 1);
  const selection = await readSelection(cookieHeader);
  if (selection.status === 'unavailable') throw new AuthBackendUnavailableError();
  if (selection.status !== 'admitted') return changed();
  const current = captureProviderBrowserContext(selection, clock());
  const flow = await openProviderSecurityFlow(sealed, operationKey, secret, clock());
  const original = flow.sourceCredentialProof;
  const selected = current.sourceCredentialProof;
  if (
    correlation.token !== current.actor.browserBindingToken ||
    correlation.bindingId !== flow.browserBindingHash ||
    current.browserCursor.bindingId !== flow.browserBindingHash ||
    current.browserCursor.version !== flow.browserVersion + 1 ||
    current.browserCursor.bindingExpiresAt !== flow.browserBindingExpiresAt ||
    current.actor.kind !== flow.actorKind ||
    current.credentialExpiresAt !== flow.credentialExpiresAt ||
    selected.userId !== original.userId ||
    selected.authSessionId !== original.authSessionId ||
    selected.generation !== original.generation + 1 ||
    selected.authenticatedAt !== original.authenticatedAt ||
    selected.linkGuarded !== original.linkGuarded ||
    Boolean(selected.requiresAccountCutoff) !== Boolean(original.requiresAccountCutoff) ||
    flow.reauthenticationToken === null ||
    flow.reauthenticationExpiresAt === null
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
    current.credentialHash === flow.actorCredentialHash
  )
    return changed();
  const now = clock().getTime();
  if (
    !Number.isSafeInteger(now) ||
    Date.parse(flow.reauthenticationExpiresAt) <= now ||
    Date.parse(flow.expiresAt) <= now ||
    Date.parse(current.credentialExpiresAt) <= now ||
    Date.parse(current.browserCursor.bindingExpiresAt) <= now
  )
    return changed();
  return Object.freeze({
    actor: Object.freeze({
      kind: previous.proof.kind,
      credential: previous.proof.rawCredential,
      expectedUserId: original.userId,
      expectedAuthSessionId: original.authSessionId,
      browserBindingToken: correlation.token,
      browserVersion: flow.browserVersion,
    }),
    intentToken: flow.intentToken,
    browserIntentToken: flow.browserIntentToken,
    recoveryToken: flow.recoveryToken,
    reauthenticationToken: flow.reauthenticationToken,
    candidate: Object.freeze({ kind: candidate.proof.kind, credential: candidate.proof.rawCredential }),
  });
}
