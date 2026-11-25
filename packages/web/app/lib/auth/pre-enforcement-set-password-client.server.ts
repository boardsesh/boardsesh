import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  AUTH_PROTOCOL_VERSION,
  SET_PASSWORD_COMPATIBILITY_PATH,
  SET_PASSWORD_COMPATIBILITY_REQUEST_BYTES,
  registrationClientAddressSchema,
  setPasswordCompatibilityCommandSchema,
  setPasswordCompatibilityReplySchema,
  setPasswordCompatibilityReplyStatus,
  type SetPasswordCompatibilityCommand,
  type SetPasswordCompatibilityReply,
} from '@boardsesh/auth-protocol';
import {
  AuthBackendUnavailableError,
  createAuthCommandTransport,
  type AuthServiceEnvironment,
} from './auth-command-transport.server';

export interface PreEnforcementSetPasswordCommandClient {
  setPassword(
    payload: SetPasswordCompatibilityCommand['payload'],
    clientAddress?: string,
  ): Promise<SetPasswordCompatibilityReply>;
}

/** Default compatibility moves the writer without changing the source session. */
export function createPreEnforcementSetPasswordCommandClient(
  options: { environment?: AuthServiceEnvironment; fetch?: typeof fetch; timeoutMs?: number } = {},
): PreEnforcementSetPasswordCommandClient {
  const transport = createAuthCommandTransport({
    ...options,
    paths: [SET_PASSWORD_COMPATIBILITY_PATH],
    requestBytes: SET_PASSWORD_COMPATIBILITY_REQUEST_BYTES,
  });
  return {
    async setPassword(payload, clientAddress) {
      try {
        const address = registrationClientAddressSchema.safeParse(clientAddress);
        const command = setPasswordCompatibilityCommandSchema.parse({
          protocolVersion: AUTH_PROTOCOL_VERSION,
          operation: 'set-password',
          requestId: randomUUID(),
          issuedAt: Date.now(),
          payload,
          ...(address.success && address.data !== undefined ? { clientAddress: address.data } : {}),
        });
        const response = await transport.post(SET_PASSWORD_COMPATIBILITY_PATH, command);
        const reply = setPasswordCompatibilityReplySchema.parse(response.body);
        if (
          reply.requestId !== command.requestId ||
          reply.operation !== command.operation ||
          setPasswordCompatibilityReplyStatus(reply) !== response.status
        )
          throw new AuthBackendUnavailableError();
        return reply;
      } catch {
        throw new AuthBackendUnavailableError();
      }
    },
  };
}
