import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  PROVIDER_SECURITY_COMMAND_PATHS,
  PROVIDER_SECURITY_REQUEST_BYTES,
  PROVIDER_SECURITY_RESPONSE_BYTES,
  PROVIDER_SECURITY_VERSION,
  providerSecurityCommandSchema,
  providerSecurityMode,
  providerSecurityReplySchema,
  providerSecurityReplyStatus,
  type ProviderSecurityCommand,
  type ProviderSecurityReply,
} from '@boardsesh/auth-protocol';
import {
  AuthBackendUnavailableError,
  createAuthCommandTransport,
  type AuthServiceEnvironment,
} from './auth-command-transport.server';

type Operation = ProviderSecurityCommand['operation'];
type PayloadOf<Name extends Operation> = Extract<ProviderSecurityCommand, { operation: Name }>['payload'];

export type ProviderSecurityRefusalReply = Extract<ProviderSecurityReply, { code: string }>;

export function isProviderSecurityRefusal(reply: ProviderSecurityReply): reply is ProviderSecurityRefusalReply {
  return 'code' in reply;
}

export type ProviderSecurityCommandClient = {
  /** Callers narrow the reply by its `outcome`; the operation is already checked. */
  send<Name extends Operation>(operation: Name, payload: PayloadOf<Name>): Promise<ProviderSecurityReply>;
};

/** www's `CURRENT_STORE_PROVIDER_SECURITY_MODE`; the provider-security routes need `backend-staging`. */
export function wwwProviderSecurityStaged(environment: AuthServiceEnvironment = process.env): boolean {
  try {
    return providerSecurityMode(environment) === 'backend-staging';
  } catch {
    return false;
  }
}

/**
 * The backend's `provider-security-v1` commands (link, unlink and
 * reauthentication keyed by the web session, #7596 B5c1) on the same private
 * channel and secret as every other www-to-backend command. One request each,
 * no retry: a lost `finalize` reply may follow a commit, and only `recover`
 * may ask about it.
 *
 * A reply counts only when its body parses as this command's own reply or a
 * refusal, with the request id it was sent with and the status that reply is
 * sent with. A transport 401, the 404 of a backend with the mode off, a 503
 * body, a timeout or anything that does not parse throws
 * `AuthBackendUnavailableError`, which callers treat as "nothing is known".
 */
export function createProviderSecurityCommandClient(
  options: { environment?: AuthServiceEnvironment; fetch?: typeof fetch; timeoutMs?: number } = {},
): ProviderSecurityCommandClient {
  const transport = createAuthCommandTransport({
    ...options,
    paths: Object.values(PROVIDER_SECURITY_COMMAND_PATHS),
    requestBytes: PROVIDER_SECURITY_REQUEST_BYTES,
    responseBytes: PROVIDER_SECURITY_RESPONSE_BYTES,
  });
  return {
    async send(operation, payload) {
      try {
        const command = providerSecurityCommandSchema.parse({
          providerSecurityVersion: PROVIDER_SECURITY_VERSION,
          requestId: randomUUID(),
          issuedAt: new Date().toISOString(),
          operation,
          payload,
        });
        const response = await transport.post(PROVIDER_SECURITY_COMMAND_PATHS[command.operation], command);
        const reply = providerSecurityReplySchema.parse(response.body);
        if (
          reply.requestId !== command.requestId ||
          reply.operation !== command.operation ||
          providerSecurityReplyStatus(reply) !== response.status ||
          // A 503 body says nothing about whether the command committed.
          reply.outcome === 'unavailable'
        )
          throw new AuthBackendUnavailableError();
        return reply;
      } catch {
        throw new AuthBackendUnavailableError();
      }
    },
  };
}
