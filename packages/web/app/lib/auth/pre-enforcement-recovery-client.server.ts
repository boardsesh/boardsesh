import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  AUTH_PROTOCOL_VERSION,
  RECOVERY_COMMAND_PATHS,
  PASSWORD_RESET_DEVICE_TOKEN_CAPABILITY_HEADER,
  recoveryFamilyForgotCommandSchema,
  recoveryFamilyResetCommandSchema,
  registrationClientAddressSchema,
  forgotPasswordReplySchema,
  resetPasswordReplySchema,
  authCommandReplyStatus,
  type RecoveryFamilyCommand,
  type ForgotPasswordReply,
  type ResetPasswordReply,
} from '@boardsesh/auth-protocol';
import {
  AuthBackendUnavailableError,
  createAuthCommandTransport,
  type AuthServiceEnvironment,
} from './auth-command-transport.server';

export interface PreEnforcementRecoveryCommandClient {
  forgotPassword(payload: unknown, clientAddress?: string): Promise<ForgotPasswordReply>;
  resetPassword(payload: unknown, clientAddress?: string): Promise<ResetPasswordReply>;
}

/** Default recovery is a strict private command, independent of staged authority modes. */
export function createPreEnforcementRecoveryCommandClient(
  options: { environment?: AuthServiceEnvironment; fetch?: typeof fetch; timeoutMs?: number } = {},
): PreEnforcementRecoveryCommandClient {
  const transport = createAuthCommandTransport({
    ...options,
    paths: Object.values(RECOVERY_COMMAND_PATHS),
    fetch: (input, init) => {
      const send = options.fetch ?? fetch;
      if (typeof input !== 'string' || new URL(input).pathname !== RECOVERY_COMMAND_PATHS['reset-password'])
        return send(input, init);
      const headers = new Headers(init?.headers);
      headers.set(PASSWORD_RESET_DEVICE_TOKEN_CAPABILITY_HEADER, '1');
      return send(input, { ...init, headers });
    },
  });
  async function send(command: RecoveryFamilyCommand) {
    try {
      const validated =
        command.operation === 'forgot-password'
          ? recoveryFamilyForgotCommandSchema.parse(command)
          : recoveryFamilyResetCommandSchema.parse(command);
      const response = await transport.post(RECOVERY_COMMAND_PATHS[validated.operation], validated);
      const reply =
        command.operation === 'forgot-password'
          ? forgotPasswordReplySchema.parse(response.body)
          : resetPasswordReplySchema.parse(response.body);
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
  }
  function context(clientAddress: string | undefined) {
    const parsed = registrationClientAddressSchema.safeParse(clientAddress);
    return parsed.success && parsed.data !== undefined ? { clientAddress: parsed.data } : {};
  }
  return {
    async forgotPassword(payload, clientAddress) {
      const command = {
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'forgot-password',
        requestId: randomUUID(),
        issuedAt: Date.now(),
        payload,
        ...context(clientAddress),
      } as const;
      const reply = await send(command);
      if (reply.operation !== 'forgot-password') throw new AuthBackendUnavailableError();
      return reply;
    },
    async resetPassword(payload, clientAddress) {
      const reply = await send({
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'reset-password',
        requestId: randomUUID(),
        issuedAt: Date.now(),
        payload,
        ...context(clientAddress),
      });
      if (reply.operation !== 'reset-password') throw new AuthBackendUnavailableError();
      return reply;
    },
  };
}
