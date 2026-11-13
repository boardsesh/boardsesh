import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import {
  BROWSER_BINDING_COMMAND_PATHS,
  BROWSER_BINDING_PROTOCOL_VERSION,
  BROWSER_BINDING_REQUEST_BYTES,
  BROWSER_BINDING_RESPONSE_BYTES,
  browserBindingCommandSchema,
  browserBindingMode,
  browserBindingReplySchema,
  browserBindingReplyStatus,
  type BrowserBindingCommand,
  type BrowserBindingReply,
} from '@boardsesh/auth-protocol/browser-binding-v1';
import {
  AuthBackendUnavailableError,
  createAuthCommandTransport,
  type AuthServiceEnvironment,
} from './auth-command-transport.server';

type Operation = BrowserBindingCommand['operation'];
type Payload<Selected extends Operation> = Extract<BrowserBindingCommand, { operation: Selected }>['payload'];
export type BrowserBindingOperationReply<Selected extends Operation> = BrowserBindingReply & { operation: Selected };
export type BrowserBindingCommandClient = {
  readonly [Selected in Operation]: (payload: Payload<Selected>) => Promise<BrowserBindingOperationReply<Selected>>;
};

/** This is a private server client. Public adapters must separately enforce
 * Origin/CSRF, canonical coordination and the exact proof-cookie selection. */
export function createBrowserBindingCommandClient(
  options: {
    readonly environment?: AuthServiceEnvironment;
    readonly fetch?: typeof fetch;
    readonly timeoutMs?: number;
  } = {},
): BrowserBindingCommandClient {
  const environment = options.environment ?? process.env;
  try {
    if (browserBindingMode(environment) !== 'backend-staging') throw new AuthBackendUnavailableError();
  } catch {
    throw new AuthBackendUnavailableError();
  }
  const transport = createAuthCommandTransport({
    ...options,
    environment,
    paths: Object.values(BROWSER_BINDING_COMMAND_PATHS),
    requestBytes: BROWSER_BINDING_REQUEST_BYTES,
    responseBytes: BROWSER_BINDING_RESPONSE_BYTES,
  });
  async function command<Selected extends Operation>(
    operation: Selected,
    payload: Payload<Selected>,
  ): Promise<BrowserBindingOperationReply<Selected>> {
    try {
      // Zod copies the complete submitted proof before the first network await.
      const request = browserBindingCommandSchema.parse({
        browserBindingProtocolVersion: BROWSER_BINDING_PROTOCOL_VERSION,
        operation,
        payload,
        requestId: randomUUID(),
        issuedAt: Date.now(),
      });
      const response = await transport.post(BROWSER_BINDING_COMMAND_PATHS[request.operation], request);
      const reply = browserBindingReplySchema.parse(response.body);
      if (
        reply.operation !== request.operation ||
        reply.requestId !== request.requestId ||
        browserBindingReplyStatus(reply) !== response.status
      )
        throw new AuthBackendUnavailableError();
      if ('cursor' in reply) {
        if (request.operation === 'bootstrap' && reply.cursor.version !== 0) throw new AuthBackendUnavailableError();
        const bindingToken =
          request.operation === 'bootstrap'
            ? reply.operation === 'bootstrap' && reply.outcome === 'created'
              ? reply.token
              : undefined
            : request.payload.bindingToken;
        if (!bindingToken || reply.cursor.bindingId !== createHash('sha256').update(bindingToken).digest('hex'))
          throw new AuthBackendUnavailableError();
        if (request.operation === 'intent' && reply.cursor.version !== request.payload.expectedVersion)
          throw new AuthBackendUnavailableError();
        if (
          request.operation === 'read' &&
          reply.outcome === 'admitted' &&
          reply.cursor.version !== request.payload.actor?.version
        )
          throw new AuthBackendUnavailableError();
        if (
          (request.operation === 'logout' || request.operation === 'login') &&
          request.payload.actor &&
          reply.cursor.version !== request.payload.actor.version + 1
        )
          throw new AuthBackendUnavailableError();
      }
      // The runtime operation equality above narrows the correlated reply.
      return reply as BrowserBindingOperationReply<Selected>;
    } catch {
      // Lost outcomes require authoritative observation, never blind mutation retry.
      throw new AuthBackendUnavailableError();
    }
  }
  return {
    bootstrap: (payload) => command('bootstrap', payload),
    describe: (payload) => command('describe', payload),
    read: (payload) => command('read', payload),
    intent: (payload) => command('intent', payload),
    login: (payload) => command('login', payload),
    logout: (payload) => command('logout', payload),
  };
}
