import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { AUTH_COMMAND_ENV } from '@boardsesh/auth-protocol';
import {
  FIRST_PASSWORD_COMMAND_PATHS,
  FIRST_PASSWORD_REQUEST_BYTES,
  FIRST_PASSWORD_RESPONSE_BYTES,
  FIRST_PASSWORD_VERSION,
  firstPasswordCommandSchema,
  firstPasswordMode,
  firstPasswordReplySchema,
  firstPasswordReplyStatus,
  type FirstPasswordCommand,
  type FirstPasswordOperation,
  type FirstPasswordReply,
} from '@boardsesh/auth-protocol';
import {
  AuthBackendUnavailableError,
  createPrivateAuthCommandTransport,
  type AuthServiceEnvironment,
} from '@boardsesh/auth-protocol/transport';
import { providerCandidateCredentialHash } from './provider-security-command-client.server';

type Payload<Operation extends FirstPasswordOperation> = Extract<
  FirstPasswordCommand,
  { operation: Operation }
>['payload'];
export type FirstPasswordOperationReply<
  Operation extends FirstPasswordOperation,
  Reply = FirstPasswordReply,
> = Reply extends { operation: infer ReplyOperation }
  ? Operation extends ReplyOperation
    ? Reply & { operation: Operation }
    : never
  : never;
export interface FirstPasswordCommandClient {
  command<Operation extends FirstPasswordOperation>(
    operation: Operation,
    payload: Payload<Operation>,
  ): Promise<FirstPasswordOperationReply<Operation>>;
}

function matchesRequest(command: FirstPasswordCommand, reply: FirstPasswordReply): boolean {
  if (reply.requestId !== command.requestId || reply.operation !== command.operation) return false;
  const { actor } = command.payload;
  if ('browserCursor' in reply) {
    const committed = reply.outcome === 'committed' || reply.outcome === 'recovered';
    if (
      reply.browserCursor.bindingId !== createHash('sha256').update(actor.browserBindingToken).digest('hex') ||
      reply.browserCursor.version !== actor.browserVersion + Number(committed)
    )
      return false;
  }
  if (reply.operation === 'request' && reply.outcome === 'issued') {
    if (reply.expiresAt !== reply.mailPlan.expiresAt) return false;
  }
  if (reply.operation === 'prepare' && reply.outcome === 'prepared') {
    if (
      reply.user.id !== actor.expectedUserId ||
      reply.credentialProof.userId !== actor.expectedUserId ||
      reply.credentialProof.authSessionId !== actor.expectedAuthSessionId ||
      (reply.proposedCanonicalToken !== null) !== (actor.kind === 'canonical-token')
    )
      return false;
  }
  if (reply.outcome === 'committed' || reply.outcome === 'recovered') {
    if (command.operation !== 'finalize' && command.operation !== 'recover') return false;
    if (reply.candidateCredentialHash !== providerCandidateCredentialHash(command.payload.candidate)) return false;
  }
  return true;
}

/** Service-only mail plans and candidate credentials never become public JSON.
 * No automatic retry: finalize can commit before its acknowledgement is lost. */
export function createFirstPasswordCommandClient(
  options: {
    readonly environment?: AuthServiceEnvironment;
    readonly fetch?: typeof fetch;
    readonly timeoutMs?: number;
  } = {},
): FirstPasswordCommandClient {
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  try {
    if (firstPasswordMode(environment) !== 'backend-staging') throw new AuthBackendUnavailableError();
  } catch {
    throw new AuthBackendUnavailableError();
  }
  const transport = createPrivateAuthCommandTransport({
    environment,
    fetch: options.fetch ?? fetch,
    timeoutMs: options.timeoutMs,
    paths: Object.values(FIRST_PASSWORD_COMMAND_PATHS),
    originKey: AUTH_COMMAND_ENV.origin,
    secretKey: AUTH_COMMAND_ENV.secret,
    disallowedSecretKeys: ['NEXTAUTH_SECRET', 'CRON_SECRET'],
    requestBytes: FIRST_PASSWORD_REQUEST_BYTES,
    responseBytes: FIRST_PASSWORD_RESPONSE_BYTES,
  });
  const client: FirstPasswordCommandClient = {
    async command(operation, payload) {
      try {
        const request = firstPasswordCommandSchema.parse({
          firstPasswordVersion: FIRST_PASSWORD_VERSION,
          requestId: randomUUID(),
          issuedAt: new Date().toISOString(),
          operation,
          payload,
        });
        const response = await transport.post(FIRST_PASSWORD_COMMAND_PATHS[request.operation], request);
        const reply = firstPasswordReplySchema.parse(response.body);
        if (!matchesRequest(request, reply) || firstPasswordReplyStatus(reply) !== response.status)
          throw new AuthBackendUnavailableError();
        // Runtime request/response operation equality above narrows this union.
        return reply as FirstPasswordOperationReply<typeof operation>;
      } catch {
        throw new AuthBackendUnavailableError();
      }
    },
  };
  return Object.freeze(client);
}
