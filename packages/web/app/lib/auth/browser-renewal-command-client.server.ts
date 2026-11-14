import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import {
  BROWSER_RENEWAL_COMMAND_PATHS,
  BROWSER_RENEWAL_REQUEST_BYTES,
  BROWSER_RENEWAL_RESPONSE_BYTES,
  browserRenewalCommandSchema,
  browserRenewalMode,
  browserRenewalReplySchema,
  browserRenewalReplyStatus,
  type BrowserRenewalCommand,
  type BrowserRenewalReply,
} from '@boardsesh/auth-protocol/browser-renewal-v1';
import {
  AuthBackendUnavailableError,
  createAuthCommandTransport,
  type AuthServiceEnvironment,
} from './auth-command-transport.server';

type Operation = BrowserRenewalCommand['operation'];
type Payload<Selected extends Operation> = Extract<BrowserRenewalCommand, { operation: Selected }>['payload'];
export type BrowserRenewalOperationReply<Selected extends Operation> = BrowserRenewalReply & { operation: Selected };
export type BrowserRenewalCommandClient = {
  readonly [Selected in Operation]: (payload: Payload<Selected>) => Promise<BrowserRenewalOperationReply<Selected>>;
};
export function browserRenewalSourceHash(credential: BrowserRenewalCommand['payload']['actor']['credential']): string {
  return createHash('sha256')
    .update(JSON.stringify(['browser-renewal-source-v1', credential]))
    .digest('hex');
}
/** No automatic finalizer retry. Observation/ACK needs actual presented old
 * and new proof; private metadata never reconstructs a missing credential. */
export function createBrowserRenewalCommandClient(
  options: {
    readonly environment?: AuthServiceEnvironment;
    readonly fetch?: typeof fetch;
    readonly timeoutMs?: number;
  } = {},
): BrowserRenewalCommandClient {
  const environment = options.environment ?? process.env;
  try {
    if (browserRenewalMode(environment) !== 'backend-staging') throw new AuthBackendUnavailableError();
  } catch {
    throw new AuthBackendUnavailableError();
  }
  const transport = createAuthCommandTransport({
    ...options,
    environment,
    paths: Object.values(BROWSER_RENEWAL_COMMAND_PATHS),
    requestBytes: BROWSER_RENEWAL_REQUEST_BYTES,
    responseBytes: BROWSER_RENEWAL_RESPONSE_BYTES,
  });
  async function command<Selected extends Operation>(
    operation: Selected,
    payload: Payload<Selected>,
  ): Promise<BrowserRenewalOperationReply<Selected>> {
    try {
      const input = browserRenewalCommandSchema.parse({
        browserRenewalProtocolVersion: 1,
        operation,
        payload,
        requestId: randomUUID(),
        issuedAt: Date.now(),
      });
      const response = await transport.post(BROWSER_RENEWAL_COMMAND_PATHS[input.operation], input);
      const reply = browserRenewalReplySchema.parse(response.body);
      if (
        reply.operation !== input.operation ||
        reply.requestId !== input.requestId ||
        browserRenewalReplyStatus(reply) !== response.status
      )
        throw new AuthBackendUnavailableError();
      if (reply.outcome === 'prepared') {
        if (
          reply.preparation.browserCursor.bindingId !==
            createHash('sha256').update(input.payload.bindingToken).digest('hex') ||
          reply.preparation.browserCursor.version !== input.payload.actor.version ||
          reply.preparation.sourceCredentialHash !== browserRenewalSourceHash(input.payload.actor.credential) ||
          reply.preparation.credentialKind !== input.payload.actor.credential.kind
        )
          throw new AuthBackendUnavailableError();
      }
      if (reply.outcome === 'completed') {
        if (
          input.operation === 'prepare' ||
          JSON.stringify(reply.cursor) !== JSON.stringify(input.payload.preparation.futureBrowserCursor) ||
          JSON.stringify(reply.credentialProof) !== JSON.stringify(input.payload.preparation.sourceCredentialProof) ||
          reply.credentialExpiresAt !== input.payload.preparation.targetExpiresAt
        )
          throw new AuthBackendUnavailableError();
      }
      return reply as BrowserRenewalOperationReply<Selected>;
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
