import 'server-only';
import { randomUUID } from 'node:crypto';
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
  type FirstPasswordReply,
} from '@boardsesh/auth-protocol';
import {
  AuthBackendUnavailableError,
  createAuthCommandTransport,
  type AuthServiceEnvironment,
} from './auth-command-transport.server';

type Operation = FirstPasswordCommand['operation'];
type PayloadOf<Name extends Operation> = Extract<FirstPasswordCommand, { operation: Name }>['payload'];
export type FirstPasswordRefusalReply = Extract<FirstPasswordReply, { code: string }>;

export type FirstPasswordCommandClient = {
  /** Callers narrow the reply by its `outcome`; the operation is already checked. */
  send<Name extends Operation>(operation: Name, payload: PayloadOf<Name>): Promise<FirstPasswordReply>;
};

/** www's `CURRENT_STORE_FIRST_PASSWORD_MODE`; the first-password routes need `backend-staging`. */
export function wwwFirstPasswordStaged(environment: AuthServiceEnvironment = process.env): boolean {
  try {
    return firstPasswordMode(environment) === 'backend-staging';
  } catch {
    return false;
  }
}

/**
 * The backend's `first-password-v1` commands (B5c2: keyed by the web session)
 * on www's private channel. One request each, no retry: a lost `finalize`
 * reply may follow a commit, and only `recover` may ask about it. A reply
 * counts only when it parses as this command's reply or a refusal, with its
 * request id, operation and status; anything else, a 503 body included, throws
 * `AuthBackendUnavailableError`.
 */
export function createFirstPasswordCommandClient(
  options: { environment?: AuthServiceEnvironment; fetch?: typeof fetch; timeoutMs?: number } = {},
): FirstPasswordCommandClient {
  const transport = createAuthCommandTransport({
    ...options,
    paths: Object.values(FIRST_PASSWORD_COMMAND_PATHS),
    requestBytes: FIRST_PASSWORD_REQUEST_BYTES,
    responseBytes: FIRST_PASSWORD_RESPONSE_BYTES,
  });
  return {
    async send(operation, payload) {
      try {
        const command = firstPasswordCommandSchema.parse({
          firstPasswordVersion: FIRST_PASSWORD_VERSION,
          requestId: randomUUID(),
          issuedAt: new Date().toISOString(),
          operation,
          payload,
        });
        const response = await transport.post(FIRST_PASSWORD_COMMAND_PATHS[command.operation], command);
        const reply = firstPasswordReplySchema.parse(response.body);
        if (
          reply.requestId !== command.requestId ||
          reply.operation !== command.operation ||
          firstPasswordReplyStatus(reply) !== response.status ||
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
