import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import {
  AUTH_COMMAND_ENV,
  PROVIDER_SECURITY_COMMAND_PATHS,
  PROVIDER_SECURITY_REQUEST_BYTES,
  PROVIDER_SECURITY_RESPONSE_BYTES,
  PROVIDER_SECURITY_VERSION,
  providerSecurityCommandSchema,
  providerSecurityMode,
  providerSecurityReplySchema,
  providerSecurityReplyStatus,
  type ProviderSecurityCommand,
  type ProviderSecurityOperation,
  type ProviderSecurityReply,
} from '@boardsesh/auth-protocol';
import {
  AuthBackendUnavailableError,
  createPrivateAuthCommandTransport,
  type AuthServiceEnvironment,
} from '@boardsesh/auth-protocol/transport';

type OperationPayload<Operation extends ProviderSecurityOperation> = Extract<
  ProviderSecurityCommand,
  { operation: Operation }
>['payload'];
export type ProviderSecurityOperationReply<
  Operation extends ProviderSecurityOperation,
  Reply = ProviderSecurityReply,
> = Reply extends { operation: infer ReplyOperation }
  ? Operation extends ReplyOperation
    ? Reply & { operation: Operation }
    : never
  : never;

export interface ProviderSecurityCommandClient {
  command<Operation extends ProviderSecurityOperation>(
    operation: Operation,
    payload: OperationPayload<Operation>,
  ): Promise<ProviderSecurityOperationReply<Operation>>;
}

export function providerCandidateCredentialHash(candidate: {
  readonly kind: 'legacy-jwe' | 'canonical-token';
  readonly credential: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify(['provider-security-credential-v1', candidate.kind, candidate.credential]))
    .digest('hex');
}

function matchesRequest(command: ProviderSecurityCommand, reply: ProviderSecurityReply): boolean {
  if (reply.requestId !== command.requestId || reply.operation !== command.operation) return false;
  const actor = command.payload.actor;
  if ('browserCursor' in reply) {
    const resultingVersion =
      reply.outcome === 'committed' || reply.outcome === 'recovered' ? actor.browserVersion + 1 : actor.browserVersion;
    if (
      reply.browserCursor.bindingId !== createHash('sha256').update(actor.browserBindingToken).digest('hex') ||
      reply.browserCursor.version !== resultingVersion
    )
      return false;
  }
  if (
    reply.outcome === 'owned' ||
    reply.outcome === 'same-owner' ||
    (reply.operation === 'prepare' && reply.outcome === 'prepared')
  ) {
    if (
      reply.user.id !== actor.expectedUserId ||
      reply.credentialProof.userId !== actor.expectedUserId ||
      reply.credentialProof.authSessionId !== actor.expectedAuthSessionId
    )
      return false;
    if (reply.outcome === 'prepared' && (reply.proposedCanonicalToken !== null) !== (actor.kind === 'canonical-token'))
      return false;
  }
  if (command.operation === 'signin-prepare' && reply.operation === 'signin-prepare' && reply.outcome === 'prepared') {
    const prepared = reply.preparation;
    if (
      prepared.provider !== command.payload.providerProof.provider ||
      prepared.subject !== command.payload.providerProof.subject ||
      reply.user.id !== prepared.credentialProof.userId ||
      prepared.credentialProof.userId === actor.expectedUserId ||
      prepared.credentialProof.authSessionId === actor.expectedAuthSessionId ||
      (reply.proposedCanonicalToken !== null) !== (actor.kind === 'canonical-token') ||
      (reply.proposedCanonicalToken === null
        ? prepared.proposedCanonicalTokenHash !== null
        : prepared.proposedCanonicalTokenHash !==
          providerCandidateCredentialHash({ kind: 'canonical-token', credential: reply.proposedCanonicalToken })) ||
      (prepared.provider !== 'google' &&
        (prepared.credentialProof.authenticatedAt !== null || prepared.credentialProof.linkGuarded)) ||
      Date.parse(prepared.credentialExpiresAt) > Date.parse(reply.browserCursor.bindingExpiresAt)
    )
      return false;
  }
  if (reply.outcome === 'committed' || reply.outcome === 'recovered') {
    if (command.operation !== 'finalize' && command.operation !== 'recover' && command.operation !== 'signin-finalize')
      return false;
    if (reply.candidateCredentialHash !== providerCandidateCredentialHash(command.payload.candidate)) return false;
  }
  return true;
}

/** Server-only commands; a lost finalizer response must never trigger an automatic retry. */
export function createProviderSecurityCommandClient(
  options: {
    environment?: AuthServiceEnvironment;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {},
): ProviderSecurityCommandClient {
  const environment = options.environment ?? process.env;
  try {
    if (providerSecurityMode(environment) !== 'backend-staging') throw new AuthBackendUnavailableError();
  } catch {
    throw new AuthBackendUnavailableError();
  }
  const transport = createPrivateAuthCommandTransport({
    environment,
    fetch: options.fetch ?? fetch,
    timeoutMs: options.timeoutMs,
    paths: Object.values(PROVIDER_SECURITY_COMMAND_PATHS),
    originKey: AUTH_COMMAND_ENV.origin,
    secretKey: AUTH_COMMAND_ENV.secret,
    disallowedSecretKeys: ['NEXTAUTH_SECRET', 'CRON_SECRET'],
    requestBytes: PROVIDER_SECURITY_REQUEST_BYTES,
    responseBytes: PROVIDER_SECURITY_RESPONSE_BYTES,
  });
  return {
    async command(operation, payload) {
      try {
        // Parsing captures caller-owned nested objects before the first await.
        const request = providerSecurityCommandSchema.parse({
          providerSecurityVersion: PROVIDER_SECURITY_VERSION,
          operation,
          requestId: randomUUID(),
          issuedAt: new Date().toISOString(),
          payload,
        });
        const response = await transport.post(PROVIDER_SECURITY_COMMAND_PATHS[request.operation], request);
        const reply = providerSecurityReplySchema.parse(response.body);
        if (!matchesRequest(request, reply) || providerSecurityReplyStatus(reply) !== response.status)
          throw new AuthBackendUnavailableError();
        // Request/reply operation equality above narrows this parsed union.
        return reply as ProviderSecurityOperationReply<typeof operation>;
      } catch {
        throw new AuthBackendUnavailableError();
      }
    },
  };
}
