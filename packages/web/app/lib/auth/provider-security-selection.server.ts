import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { webCredentialProofSchema, type ProviderSecurityActor } from '@boardsesh/auth-protocol';
import {
  browserBindingCursorSchema,
  browserSelectionPossessionSchema,
  type BrowserBindingReply,
  type BrowserSelectionPossession,
} from '@boardsesh/auth-protocol/browser-binding-v1';
import { AuthBackendUnavailableError } from './auth-command-transport.server';
import { providerCandidateCredentialHash } from './provider-security-command-client.server';
import type { ProviderSecurityFlow } from './provider-security-flow.server';

type AdmittedRead = Extract<BrowserBindingReply, { outcome: 'admitted' }>;
/** Projection of the central presented-browser reader's admitted result only.
 * This module does not read cookies, look up sessions or admit credentials. */
export interface ProviderAdmittedBrowserSelection {
  readonly status: 'admitted';
  readonly bindingToken: string;
  readonly actor: BrowserSelectionPossession;
  readonly cursor: AdmittedRead['cursor'];
  readonly session: AdmittedRead['session'];
  readonly user: AdmittedRead['user'];
}
export class ProviderSecurityIdentityChangedError extends Error {
  constructor() {
    super('Provider security identity changed');
  }
}
function unavailable(): never {
  throw new AuthBackendUnavailableError();
}
function deadline(iso: string): number {
  const result = Date.parse(iso);
  if (!Number.isSafeInteger(result) || result <= 0) return unavailable();
  return result;
}
export function providerBindingHash(bindingToken: string): string {
  return createHash('sha256')
    .update(
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{43}$/)
        .parse(bindingToken),
    )
    .digest('hex');
}

/** Capture the actual source before any command/flow work awaits. No new clock
 * is used as authentication provenance; the clock only checks existing expiry. */
export function captureProviderBrowserContext(selection: ProviderAdmittedBrowserSelection, now = new Date()) {
  const possession = browserSelectionPossessionSchema.parse(selection.actor);
  const cursor = browserBindingCursorSchema.parse(selection.cursor);
  const bindingToken = selection.bindingToken;
  const credential =
    possession.credential.kind === 'canonical-token' ? possession.credential.token : possession.credential.credential;
  const credentialProof = webCredentialProofSchema.parse({
    version: 1,
    userId: selection.session.userId,
    authSessionId: selection.session.authSessionId,
    generation: selection.session.generation,
    authenticatedAt: selection.session.authenticatedAt,
    linkGuarded: selection.session.linkGuarded,
    ...(selection.session.requiresAccountCutoff ? { requiresAccountCutoff: true } : {}),
  });
  const expiresAt = selection.session.expiresAt;
  const clock = now.getTime();
  if (
    selection.status !== 'admitted' ||
    selection.user.id !== credentialProof.userId ||
    !Number.isSafeInteger(clock) ||
    clock <= 0 ||
    deadline(expiresAt) <= clock ||
    deadline(cursor.bindingExpiresAt) <= clock ||
    cursor.bindingId !== providerBindingHash(bindingToken) ||
    cursor.version !== possession.version ||
    cursor.version >= 2_147_483_647 ||
    credentialProof.generation >= 2_147_483_647 ||
    (credentialProof.authenticatedAt === null
      ? credentialProof.linkGuarded
      : deadline(credentialProof.authenticatedAt) > clock)
  )
    return unavailable();
  const actor: Readonly<ProviderSecurityActor> = Object.freeze({
    kind: possession.credential.kind,
    credential,
    expectedUserId: credentialProof.userId,
    expectedAuthSessionId: credentialProof.authSessionId,
    browserBindingToken: bindingToken,
    browserVersion: cursor.version,
  });
  const credentialHash = providerCandidateCredentialHash(actor);
  const actorContextKey = createHash('sha256')
    .update(
      JSON.stringify([
        'provider-security-ui-context-v1',
        credentialProof.userId,
        credentialProof.authSessionId,
        credentialProof.generation,
        cursor.bindingId,
        cursor.version,
        credentialHash,
      ]),
    )
    .digest('hex');
  return Object.freeze({
    actor,
    actorContextKey,
    credentialHash,
    sourceCredentialProof: Object.freeze(credentialProof),
    credentialExpiresAt: expiresAt,
    browserCursor: Object.freeze(cursor),
  });
}
export type ProviderBrowserContext = ReturnType<typeof captureProviderBrowserContext>;

export type ProviderSecurityFlowSource = Pick<
  ProviderSecurityFlow,
  | 'actorKind'
  | 'actorCredentialHash'
  | 'browserBindingHash'
  | 'browserVersion'
  | 'browserBindingExpiresAt'
  | 'sourceCredentialProof'
  | 'credentialExpiresAt'
>;

export function requireProviderSecurityFlowActor(
  flow: ProviderSecurityFlowSource,
  current: ProviderBrowserContext,
): void {
  const before = flow.sourceCredentialProof;
  const after = current.sourceCredentialProof;
  if (
    flow.actorKind !== current.actor.kind ||
    flow.actorCredentialHash !== current.credentialHash ||
    flow.browserBindingHash !== current.browserCursor.bindingId ||
    flow.browserVersion !== current.browserCursor.version ||
    flow.browserBindingExpiresAt !== current.browserCursor.bindingExpiresAt ||
    flow.credentialExpiresAt !== current.credentialExpiresAt ||
    before.userId !== after.userId ||
    before.authSessionId !== after.authSessionId ||
    before.generation !== after.generation ||
    before.authenticatedAt !== after.authenticatedAt ||
    before.linkGuarded !== after.linkGuarded ||
    Boolean(before.requiresAccountCutoff) !== Boolean(after.requiresAccountCutoff)
  )
    throw new ProviderSecurityIdentityChangedError();
}
