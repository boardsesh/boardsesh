import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  AUTH_PROTOCOL_VERSION,
  PRE_ENFORCEMENT_PASSWORD_PATH,
  WEB_CREDENTIAL_PROOF_VERSION,
  preEnforcementPasswordCommandSchema,
  preEnforcementPasswordReplySchema,
  authCommandReplyStatus,
} from '@boardsesh/auth-protocol';
import {
  AuthBackendUnavailableError,
  createAuthCommandTransport,
  type AuthServiceEnvironment,
} from './auth-command-transport.server';
import type { PasswordCommandClient } from './password-command-client.server';

/** The default web password family is independent of qualified staged modes. */
export function createPreEnforcementPasswordCommandClient(
  options: { environment?: AuthServiceEnvironment; fetch?: typeof fetch; timeoutMs?: number } = {},
): Pick<PasswordCommandClient, 'password'> {
  const transport = createAuthCommandTransport({ ...options, paths: [PRE_ENFORCEMENT_PASSWORD_PATH] });
  return {
    async password(email, password, clientAddress, requestOptions) {
      try {
        if (requestOptions?.webSession !== undefined) throw new AuthBackendUnavailableError();
        const address = preEnforcementPasswordCommandSchema.shape.clientAddress.safeParse(clientAddress);
        const command = {
          protocolVersion: AUTH_PROTOCOL_VERSION,
          operation: 'password',
          credentialProofVersion: WEB_CREDENTIAL_PROOF_VERSION,
          requestId: randomUUID(),
          issuedAt: Date.now(),
          payload: { email, password },
          ...(address.success && address.data !== undefined ? { clientAddress: address.data } : {}),
          ...(requestOptions?.deviceToken ? { deviceToken: requestOptions.deviceToken } : {}),
        } as const;
        const response = await transport.post(PRE_ENFORCEMENT_PASSWORD_PATH, command);
        const reply = preEnforcementPasswordReplySchema.parse(response.body);
        if (
          reply.requestId !== command.requestId ||
          reply.operation !== command.operation ||
          authCommandReplyStatus(reply) !== response.status
        )
          throw new AuthBackendUnavailableError();
        return reply;
      } catch {
        throw new AuthBackendUnavailableError();
      }
    },
  };
}
