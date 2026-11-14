import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import {
  ANONYMOUS_PROVIDER_PATHS,
  ANONYMOUS_PROVIDER_REQUEST_BYTES,
  ANONYMOUS_PROVIDER_RESPONSE_BYTES,
  anonymousProviderCommandSchema,
  anonymousProviderReplySchema,
  anonymousProviderReplyStatus,
  providerSecurityMode,
  type AnonymousProviderCommand,
  type AnonymousProviderOperation,
  type AnonymousProviderReply,
} from '@boardsesh/auth-protocol';
import {
  AuthBackendUnavailableError,
  createAuthCommandTransport,
  type AuthServiceEnvironment,
} from './auth-command-transport.server';
import { providerCandidateCredentialHash } from './provider-security-command-client.server';

type Payload<Operation extends AnonymousProviderOperation> = Extract<
  AnonymousProviderCommand,
  { operation: Operation }
>['payload'];
export type AnonymousProviderOperationReply<
  Operation extends AnonymousProviderOperation,
  Reply = AnonymousProviderReply,
> = Reply extends { operation: infer ReplyOperation }
  ? Operation extends ReplyOperation
    ? Reply & { operation: Operation }
    : never
  : never;
export interface AnonymousProviderCommandClient {
  command<Operation extends AnonymousProviderOperation>(
    operation: Operation,
    payload: Payload<Operation>,
  ): Promise<AnonymousProviderOperationReply<Operation>>;
}

function matches(command: AnonymousProviderCommand, reply: AnonymousProviderReply): boolean {
  if (reply.requestId !== command.requestId || reply.operation !== command.operation) return false;
  if ('browserCursor' in reply) {
    const browser = command.payload.browser;
    const resultingVersion = browser.expectedVersion + (reply.operation === 'finalize' ? 1 : 0);
    if (
      reply.browserCursor.bindingId !== createHash('sha256').update(browser.bindingToken).digest('hex') ||
      reply.browserCursor.version !== resultingVersion
    )
      return false;
  }
  if (command.operation === 'prepare' && reply.operation === 'prepare' && reply.outcome === 'prepared') {
    const target = reply.preparation;
    const proof = target.credentialProof;
    const assertion = command.payload.providerProof;
    if (
      target.credentialKind !== command.payload.credentialKind ||
      target.identityPlan.provider !== assertion.provider ||
      target.identityPlan.subject !== assertion.identity.sub ||
      JSON.stringify(target.verifiedIdentity) !== JSON.stringify(assertion.identity) ||
      proof.userId !== target.identityPlan.user.id ||
      proof.generation !== target.identityPlan.generation ||
      proof.requiresAccountCutoff ||
      (target.identityPlan.kind === 'new' && target.identityPlan.generation !== 0) ||
      (proof.authenticatedAt === null ? proof.linkGuarded : !proof.linkGuarded) ||
      (assertion.provider === 'apple' && (proof.authenticatedAt !== null || proof.linkGuarded)) ||
      (reply.proposedCanonicalToken !== null) !== (target.credentialKind === 'canonical-token') ||
      (reply.proposedCanonicalToken === null
        ? target.proposedCanonicalTokenHash !== null
        : target.proposedCanonicalTokenHash !==
          providerCandidateCredentialHash({ kind: 'canonical-token', credential: reply.proposedCanonicalToken })) ||
      Date.parse(target.expiresAt) > Date.parse(target.credentialExpiresAt) ||
      Date.parse(target.credentialExpiresAt) > Date.parse(reply.browserCursor.bindingExpiresAt)
    )
      return false;
  }
  if (reply.outcome === 'committed' || reply.outcome === 'recovered') {
    if (
      command.operation !== 'finalize' ||
      reply.candidateCredentialHash !== providerCandidateCredentialHash(command.payload.candidate)
    )
      return false;
  }
  return true;
}

/** Separate source-free transport. One POST per command; finalization is never retried. */
export function createAnonymousProviderCommandClient(
  options: {
    readonly environment?: AuthServiceEnvironment;
    readonly fetch?: typeof fetch;
    readonly timeoutMs?: number;
  } = {},
): AnonymousProviderCommandClient {
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  try {
    if (providerSecurityMode(environment) !== 'backend-staging') throw new AuthBackendUnavailableError();
  } catch {
    throw new AuthBackendUnavailableError();
  }
  const transport = createAuthCommandTransport({
    environment,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
    paths: Object.values(ANONYMOUS_PROVIDER_PATHS),
    requestBytes: ANONYMOUS_PROVIDER_REQUEST_BYTES,
    responseBytes: ANONYMOUS_PROVIDER_RESPONSE_BYTES,
  });
  return Object.freeze({
    async command<Operation extends AnonymousProviderOperation>(operation: Operation, payload: Payload<Operation>) {
      try {
        const request = anonymousProviderCommandSchema.parse({
          anonymousProviderVersion: 1,
          operation,
          requestId: randomUUID(),
          issuedAt: new Date().toISOString(),
          payload,
        });
        const response = await transport.post(ANONYMOUS_PROVIDER_PATHS[request.operation], request);
        const reply = anonymousProviderReplySchema.parse(response.body);
        if (!matches(request, reply) || anonymousProviderReplyStatus(reply) !== response.status)
          throw new AuthBackendUnavailableError();
        return reply as AnonymousProviderOperationReply<Operation>;
      } catch {
        throw new AuthBackendUnavailableError();
      }
    },
  });
}
