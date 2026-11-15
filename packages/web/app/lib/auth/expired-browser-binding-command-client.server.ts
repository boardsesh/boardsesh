import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import {
  EXPIRED_BROWSER_BINDING_COMMAND_PATHS,
  EXPIRED_BROWSER_BINDING_REQUEST_BYTES,
  EXPIRED_BROWSER_BINDING_RESPONSE_BYTES,
  expiredBrowserBindingCommandSchema,
  expiredBrowserBindingMode,
  expiredBrowserBindingReplySchema,
  expiredBrowserBindingReplyStatus,
  type ExpiredBrowserBindingCommand,
  type ExpiredBrowserBindingReply,
} from '@boardsesh/auth-protocol/expired-browser-binding-v1';
import {
  AuthBackendUnavailableError,
  createAuthCommandTransport,
  type AuthServiceEnvironment,
} from './auth-command-transport.server';

type Operation = ExpiredBrowserBindingCommand['operation'];
type Payload<Selected extends Operation> = Extract<ExpiredBrowserBindingCommand, { operation: Selected }>['payload'];
export type ExpiredBrowserBindingOperationReply<Selected extends Operation> = ExpiredBrowserBindingReply & {
  readonly operation: Selected;
};
export type ExpiredBrowserBindingCommandClient = {
  readonly [Selected in Operation]: (
    payload: Payload<Selected>,
  ) => Promise<ExpiredBrowserBindingOperationReply<Selected>>;
};
function bindingTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
/** Fixed private destinations and actual old/target token correlation for an
 * explicit expired-binding action. The public adapter owns physical delivery. */
export function createExpiredBrowserBindingCommandClient(
  options: {
    readonly environment?: AuthServiceEnvironment;
    readonly fetch?: typeof fetch;
    readonly timeoutMs?: number;
  } = {},
): ExpiredBrowserBindingCommandClient {
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  try {
    if (expiredBrowserBindingMode(environment) !== 'backend-staging') throw new AuthBackendUnavailableError();
  } catch {
    throw new AuthBackendUnavailableError();
  }
  const transport = createAuthCommandTransport({
    ...options,
    environment,
    paths: Object.values(EXPIRED_BROWSER_BINDING_COMMAND_PATHS),
    requestBytes: EXPIRED_BROWSER_BINDING_REQUEST_BYTES,
    responseBytes: EXPIRED_BROWSER_BINDING_RESPONSE_BYTES,
  });
  async function command<Selected extends Operation>(
    operation: Selected,
    payload: Payload<Selected>,
  ): Promise<ExpiredBrowserBindingOperationReply<Selected>> {
    try {
      const submitted = expiredBrowserBindingCommandSchema.parse({
        expiredBrowserBindingProtocolVersion: 1,
        requestId: randomUUID(),
        issuedAt: Date.now(),
        operation,
        payload,
      });
      if (
        submitted.operation !== 'prepare' &&
        (bindingTokenHash(submitted.payload.bindingToken) !== submitted.payload.preparation.oldBindingId ||
          bindingTokenHash(submitted.payload.targetBindingToken) !==
            submitted.payload.preparation.targetCursor.bindingId)
      )
        throw new AuthBackendUnavailableError();
      const response = await transport.post(EXPIRED_BROWSER_BINDING_COMMAND_PATHS[submitted.operation], submitted);
      const reply = expiredBrowserBindingReplySchema.parse(response.body);
      if (
        reply.operation !== submitted.operation ||
        reply.requestId !== submitted.requestId ||
        expiredBrowserBindingReplyStatus(reply) !== response.status
      )
        throw new AuthBackendUnavailableError();
      if (reply.outcome === 'prepared') {
        if (
          submitted.operation !== 'prepare' ||
          reply.preparation.oldBindingId !== bindingTokenHash(submitted.payload.bindingToken) ||
          (submitted.payload.expectedVersion !== undefined &&
            reply.preparation.oldVersion !== submitted.payload.expectedVersion) ||
          reply.preparation.nonceHash !== submitted.payload.nonceHash ||
          reply.preparation.targetCursor.bindingId !== bindingTokenHash(reply.targetBindingToken)
        )
          throw new AuthBackendUnavailableError();
      }
      if (reply.outcome === 'completed') {
        if (
          submitted.operation === 'prepare' ||
          reply.cursor.bindingId !== submitted.payload.preparation.targetCursor.bindingId ||
          reply.cursor.version !== submitted.payload.preparation.targetCursor.version ||
          reply.cursor.bindingExpiresAt !== submitted.payload.preparation.targetCursor.bindingExpiresAt
        )
          throw new AuthBackendUnavailableError();
      }
      return reply as ExpiredBrowserBindingOperationReply<Selected>;
    } catch {
      throw new AuthBackendUnavailableError();
    }
  }
  return {
    prepare: (payload) => command('prepare', payload),
    finalize: (payload) => command('finalize', payload),
    acknowledge: (payload) => command('acknowledge', payload),
  };
}
