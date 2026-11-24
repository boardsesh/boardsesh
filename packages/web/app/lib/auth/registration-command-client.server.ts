import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  AUTH_PROTOCOL_VERSION,
  REGISTRATION_COMMAND_PATHS,
  authCommandReplyStatus,
  registerReplySchema,
  resendVerificationReplySchema,
  verifyEmailReplySchema,
  registrationClientAddressSchema,
  type RegistrationFamilyCommand,
} from '@boardsesh/auth-protocol';
import {
  AuthBackendUnavailableError,
  createAuthCommandTransport,
  type AuthServiceEnvironment,
} from './auth-command-transport.server';
import {
  createPasswordCommandClient,
  webPasswordMode,
  type EmailVerificationCommandClient,
  type PasswordCommandClient,
} from './password-command-client.server';

type RegistrationClient = Pick<PasswordCommandClient, 'register'> & EmailVerificationCommandClient;

/**
 * Default current-store writers need no enforced projection or browser proof.
 * Explicit staged mode retains the existing qualified command path. Neither
 * path retries or writes locally after an unknown acknowledgement.
 */
export function createRegistrationCommandClient(
  options: {
    environment?: AuthServiceEnvironment;
    fetch?: typeof fetch;
    timeoutMs?: number;
    /** Server-vouched request context, independent of browser JSON payloads. */
    clientAddress?: string | null;
  } = {},
): RegistrationClient {
  const environment = options.environment ?? process.env;
  if (webPasswordMode(environment) === 'backend-staging') return createPasswordCommandClient(options);
  const address = registrationClientAddressSchema.safeParse(options.clientAddress ?? undefined);
  if (!address.success) throw new AuthBackendUnavailableError();
  const transport = createAuthCommandTransport({
    ...options,
    environment,
    paths: Object.values(REGISTRATION_COMMAND_PATHS),
  });
  async function command(input: RegistrationFamilyCommand) {
    try {
      const response = await transport.post(REGISTRATION_COMMAND_PATHS[input.operation], input);
      const schema =
        input.operation === 'register'
          ? registerReplySchema
          : input.operation === 'verify-email'
            ? verifyEmailReplySchema
            : resendVerificationReplySchema;
      const reply = schema.parse(response.body);
      if (
        reply.operation !== input.operation ||
        reply.requestId !== input.requestId ||
        authCommandReplyStatus(reply) !== response.status
      )
        throw new AuthBackendUnavailableError();
      return reply;
    } catch {
      throw new AuthBackendUnavailableError();
    }
  }
  const metadata = () =>
    ({
      protocolVersion: AUTH_PROTOCOL_VERSION,
      requestId: randomUUID(),
      issuedAt: Date.now(),
      ...(address.data ? { clientAddress: address.data } : {}),
    }) as const;
  return {
    async register(payload) {
      return registerReplySchema.parse(await command({ ...metadata(), operation: 'register', payload }));
    },
    async resendVerification(payload) {
      return resendVerificationReplySchema.parse(
        await command({ ...metadata(), operation: 'resend-verification', payload }),
      );
    },
    async verifyEmail(token, email) {
      return verifyEmailReplySchema.parse(
        await command({
          ...metadata(),
          operation: 'verify-email',
          payload: { token, ...(email === undefined ? {} : { email }) },
        }),
      );
    },
  };
}
