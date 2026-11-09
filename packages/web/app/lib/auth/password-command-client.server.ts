import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  AUTH_COMMAND_ENV,
  AUTH_COMMAND_PATHS,
  AUTH_PROTOCOL_VERSION,
  authCommandReplySchema,
  authCommandReplyStatus,
  parseWebAuthMode,
  type AuthCommand,
  type AuthCommandReply,
  type PasswordReply,
  type RegisterReply,
  type VerifyEmailReply,
  type ResendVerificationReply,
  type ForgotPasswordReply,
  type ResetPasswordReply,
} from '@boardsesh/auth-protocol';

import {
  AuthBackendUnavailableError,
  createAuthCommandTransport,
  trustedAuthOrigin,
  type AuthServiceEnvironment,
} from './auth-command-transport.server';

export { AuthBackendUnavailableError } from './auth-command-transport.server';
type AuthEnvironment = AuthServiceEnvironment;

export function webPasswordMode(environment: AuthEnvironment = process.env) {
  try {
    return parseWebAuthMode(environment[AUTH_COMMAND_ENV.mode]);
  } catch {
    throw new AuthBackendUnavailableError();
  }
}

/** Resolve only trusted configuration before registration can perform a write. */
export function registrationMailOrigin(requestOrigin: string, environment: AuthEnvironment = process.env): string {
  try {
    const configured = environment.BASE_URL?.trim() || environment.NEXTAUTH_URL?.trim();
    if (configured) return trustedAuthOrigin(configured, environment);
    const local = new URL(requestOrigin);
    if (
      !['development', 'test'].includes(environment.NODE_ENV ?? '') ||
      !['localhost', '127.0.0.1', '[::1]'].includes(local.hostname)
    )
      throw new AuthBackendUnavailableError();
    return trustedAuthOrigin(requestOrigin, environment);
  } catch {
    throw new AuthBackendUnavailableError();
  }
}

export type PasswordCommandClient = {
  register(payload: unknown): Promise<RegisterReply>;
  password(email: string, password: string): Promise<PasswordReply>;
};
export type EmailVerificationCommandClient = {
  verifyEmail(token: string, email?: string): Promise<VerifyEmailReply>;
  resendVerification(payload: unknown): Promise<ResendVerificationReply>;
};
export type PasswordRecoveryCommandClient = {
  forgotPassword(payload: unknown): Promise<ForgotPasswordReply>;
  resetPassword(payload: unknown): Promise<ResetPasswordReply>;
};

/** Fixed server-only commands. No retry: a lost reply may follow a commit. */
export function createPasswordCommandClient(
  options: {
    environment?: AuthEnvironment;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {},
): PasswordCommandClient & EmailVerificationCommandClient & PasswordRecoveryCommandClient {
  const environment = options.environment ?? process.env;
  try {
    if (webPasswordMode(environment) !== 'backend-staging') throw new AuthBackendUnavailableError();
  } catch {
    throw new AuthBackendUnavailableError();
  }
  const transport = createAuthCommandTransport({
    ...options,
    environment,
    paths: Object.values(AUTH_COMMAND_PATHS),
  });
  async function command(command: AuthCommand): Promise<AuthCommandReply> {
    try {
      const response = await transport.post(AUTH_COMMAND_PATHS[command.operation], command);
      const reply = authCommandReplySchema.parse(response.body);
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

  return {
    async register(payload) {
      return (await command({
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'register',
        requestId: randomUUID(),
        issuedAt: Date.now(),
        payload,
      })) as RegisterReply;
    },
    async password(email, password) {
      return (await command({
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'password',
        requestId: randomUUID(),
        issuedAt: Date.now(),
        payload: { email, password },
      })) as PasswordReply;
    },
    async verifyEmail(token, email) {
      return (await command({
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'verify-email',
        requestId: randomUUID(),
        issuedAt: Date.now(),
        payload: { token, ...(email !== undefined ? { email } : {}) },
      })) as VerifyEmailReply;
    },
    async resendVerification(payload) {
      return (await command({
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'resend-verification',
        requestId: randomUUID(),
        issuedAt: Date.now(),
        payload,
      })) as ResendVerificationReply;
    },
    async forgotPassword(payload) {
      return (await command({
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'forgot-password',
        requestId: randomUUID(),
        issuedAt: Date.now(),
        payload,
      })) as ForgotPasswordReply;
    },
    async resetPassword(payload) {
      return (await command({
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'reset-password',
        requestId: randomUUID(),
        issuedAt: Date.now(),
        payload,
      })) as ResetPasswordReply;
    },
  };
}
