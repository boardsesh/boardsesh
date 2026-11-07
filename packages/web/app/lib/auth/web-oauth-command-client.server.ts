import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  WEB_OAUTH_COMMAND_PATHS,
  WEB_OAUTH_PROTOCOL_VERSION,
  parseWebAuthMode,
  webOAuthCommandSchema,
  webOAuthReplySchema,
  webOAuthReplyStatus,
  type WebOAuthCommand,
  type WebOAuthIntentCommand,
  type WebOAuthIntentReply,
  type WebOAuthResolveCommand,
  type WebOAuthResolveReply,
} from '@boardsesh/auth-protocol';
import {
  AuthBackendUnavailableError,
  createAuthCommandTransport,
  type AuthServiceEnvironment,
} from './auth-command-transport.server';

export function webOAuthMode(environment: AuthServiceEnvironment = process.env) {
  try {
    return parseWebAuthMode(environment.CURRENT_STORE_WEB_OAUTH_MODE);
  } catch {
    throw new AuthBackendUnavailableError();
  }
}

export interface WebOAuthCommandClient {
  intent(payload: WebOAuthIntentCommand['payload']): Promise<WebOAuthIntentReply>;
  resolve(payload: WebOAuthResolveCommand['payload']): Promise<WebOAuthResolveReply>;
}

/** Identity-only commands; never retry an outcome that may have committed. */
export function createWebOAuthCommandClient(
  options: { environment?: AuthServiceEnvironment; fetch?: typeof fetch; timeoutMs?: number } = {},
): WebOAuthCommandClient {
  const environment = options.environment ?? process.env;
  if (webOAuthMode(environment) !== 'backend-staging') throw new AuthBackendUnavailableError();
  const transport = createAuthCommandTransport({
    ...options,
    environment,
    paths: Object.values(WEB_OAUTH_COMMAND_PATHS),
  });

  async function command(input: WebOAuthCommand) {
    try {
      // Capture validated copies before network I/O; caller mutations cannot
      // retarget the correlation checks after a reply arrives.
      const request = webOAuthCommandSchema.parse(input);
      const response = await transport.post(WEB_OAUTH_COMMAND_PATHS[request.operation], request);
      const reply = webOAuthReplySchema.parse(response.body);
      if (
        reply.requestId !== request.requestId ||
        reply.operation !== request.operation ||
        webOAuthReplyStatus(reply) !== response.status
      )
        throw new AuthBackendUnavailableError();
      if (reply.outcome === 'recorded' && request.operation === 'intent' && reply.flow !== request.payload.flow)
        throw new AuthBackendUnavailableError();
      if (
        reply.outcome === 'resolved' &&
        request.operation === 'resolve' &&
        (reply.account.provider !== request.payload.provider ||
          reply.account.providerAccountId !== request.payload.subject)
      )
        throw new AuthBackendUnavailableError();
      return reply;
    } catch {
      throw new AuthBackendUnavailableError();
    }
  }

  return {
    async intent(payload) {
      return (await command({
        webOAuthProtocolVersion: WEB_OAUTH_PROTOCOL_VERSION,
        operation: 'intent',
        requestId: randomUUID(),
        issuedAt: new Date().toISOString(),
        payload,
      })) as WebOAuthIntentReply;
    },
    async resolve(payload) {
      return (await command({
        webOAuthProtocolVersion: WEB_OAUTH_PROTOCOL_VERSION,
        operation: 'resolve',
        requestId: randomUUID(),
        issuedAt: new Date().toISOString(),
        payload,
      })) as WebOAuthResolveReply;
    },
  };
}
