import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  WEB_CREDENTIAL_PROOF_VERSION,
  PASSWORD_RESET_DEVICE_TOKEN_CAPABILITY_HEADER,
  webCredentialProofMode,
  AUTH_COMMAND_ENV,
  AUTH_COMMAND_PATHS,
  AUTH_PROTOCOL_VERSION,
  authCommandReplySchema,
  authCommandReplyStatus,
  parseWebAuthMode,
  passwordCommandSchema,
  type AuthCommand,
  type AuthCommandReply,
  type PasswordReply,
  type RegisterReply,
  type VerifyEmailReply,
  type ResendVerificationReply,
  type ForgotPasswordReply,
  type ResetPasswordReply,
  type SetPasswordReply,
  type PresentedWebSession,
  type WebSessionRequest,
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

export type PasswordCommandRequestOptions = { webSession?: WebSessionRequest; deviceToken?: string };

export type PasswordCommandClient = {
  register(payload: unknown): Promise<RegisterReply>;
  /**
   * `clientAddress` is the visitor a trusted edge vouched for. The backend keys
   * its per-client sign-in limit on it; without it the sign-in takes the
   * backend's per-process budget. `webSession` asks the backend to issue a
   * first-party web session for the account the password proves, revoking
   * `webSession.presented` (#7596); only `AUTH_BROWSER_SESSION_MODE=better-auth`
   * sends it.
   */
  password(
    email: string,
    password: string,
    clientAddress?: string,
    requestOptions?: PasswordCommandRequestOptions,
  ): Promise<PasswordReply>;
};
/**
 * The address to send, or undefined for one the command schema would refuse
 * (Node accepts a zone index such as `%en0`; the schema does not). A refused
 * command answers 400 and fails the sign-in, while a missing address only
 * moves it to the backend's per-process budget.
 */
function sendableClientAddress(clientAddress: string | undefined): string | undefined {
  const parsed = passwordCommandSchema.shape.clientAddress.safeParse(clientAddress);
  return parsed.success ? parsed.data : undefined;
}

export type EmailVerificationCommandClient = {
  verifyEmail(token: string, email?: string): Promise<VerifyEmailReply>;
  resendVerification(payload: unknown): Promise<ResendVerificationReply>;
};
export type SetPasswordCommandClient = {
  setPassword(
    credential: string,
    password: string,
    confirmPassword: string,
    expectedUserId: string,
    expectedAuthSessionId: string,
  ): Promise<SetPasswordReply>;
  /**
   * The second form (#7596 B4b): presents the session as the web-session
   * commands do. A canonical token keeps its session and token through the
   * password write; www writes no cookie from the reply.
   */
  setPasswordForSession(
    presented: PresentedWebSession,
    password: string,
    confirmPassword: string,
    expectedUserId: string,
    expectedAuthSessionId: string,
  ): Promise<SetPasswordReply>;
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
): PasswordCommandClient & EmailVerificationCommandClient & PasswordRecoveryCommandClient & SetPasswordCommandClient {
  const environment = options.environment ?? process.env;
  if (webCredentialProofMode(environment) === 'compatible') throw new AuthBackendUnavailableError();
  try {
    if (webPasswordMode(environment) !== 'backend-staging') throw new AuthBackendUnavailableError();
  } catch {
    throw new AuthBackendUnavailableError();
  }
  const transport = createAuthCommandTransport({
    ...options,
    environment,
    paths: Object.values(AUTH_COMMAND_PATHS),
    // An unknown header is ignored by old backends. Old web callers omit it,
    // so a newly seeded backend must retain their original strict reply.
    fetch: (input, init) => {
      const send = options.fetch ?? fetch;
      if (typeof input !== 'string' || new URL(input).pathname !== AUTH_COMMAND_PATHS['reset-password'])
        return send(input, init);
      const headers = new Headers(init?.headers);
      headers.set(PASSWORD_RESET_DEVICE_TOKEN_CAPABILITY_HEADER, '1');
      return send(input, { ...init, headers });
    },
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
      if (
        command.operation === 'password' &&
        command.credentialProofVersion &&
        reply.operation === 'password' &&
        reply.outcome === 'authenticated' &&
        !reply.credentialProof
      )
        throw new AuthBackendUnavailableError();
      return reply;
    } catch {
      throw new AuthBackendUnavailableError();
    }
  }

  return {
    async setPasswordForSession(presented, password, confirmPassword, expectedUserId, expectedAuthSessionId) {
      return (await command({
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'set-password',
        requestId: randomUUID(),
        issuedAt: Date.now(),
        payload: { presented, password, confirmPassword, expectedUserId, expectedAuthSessionId },
      })) as SetPasswordReply;
    },
    async setPassword(credential, password, confirmPassword, expectedUserId, expectedAuthSessionId) {
      return (await command({
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'set-password',
        requestId: randomUUID(),
        issuedAt: Date.now(),
        payload: { credential, password, confirmPassword, expectedUserId, expectedAuthSessionId },
      })) as SetPasswordReply;
    },
    async register(payload) {
      return (await command({
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'register',
        requestId: randomUUID(),
        issuedAt: Date.now(),
        payload,
      })) as RegisterReply;
    },
    async password(email, password, clientAddress, requestOptions) {
      const sendableAddress = sendableClientAddress(clientAddress);
      return (await command({
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'password',
        ...(webCredentialProofMode(environment) === 'required'
          ? { credentialProofVersion: WEB_CREDENTIAL_PROOF_VERSION }
          : {}),
        ...(sendableAddress ? { clientAddress: sendableAddress } : {}),
        ...(requestOptions?.webSession ? { webSession: requestOptions.webSession } : {}),
        ...(requestOptions?.deviceToken ? { deviceToken: requestOptions.deviceToken } : {}),
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
