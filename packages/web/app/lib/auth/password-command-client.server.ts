import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  AUTH_BACKEND_UNAVAILABLE,
  AUTH_COMMAND_ENV,
  AUTH_COMMAND_PATHS,
  AUTH_COMMAND_REQUEST_BYTES,
  AUTH_COMMAND_RESPONSE_BYTES,
  AUTH_COMMAND_TIMEOUT_MS,
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

type AuthEnvironment = Readonly<Record<string, string | undefined>>;

export class AuthBackendUnavailableError extends Error {
  constructor() {
    super(AUTH_BACKEND_UNAVAILABLE);
    this.name = 'AuthBackendUnavailableError';
  }
}

export function webPasswordMode(environment: AuthEnvironment = process.env) {
  try {
    return parseWebAuthMode(environment[AUTH_COMMAND_ENV.mode]);
  } catch {
    throw new AuthBackendUnavailableError();
  }
}

function trustedOrigin(configured: string, environment: AuthEnvironment): string {
  const origin = new URL(configured);
  const ownedLocal =
    (environment.NODE_ENV === 'development' || environment.NODE_ENV === 'test') &&
    ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (
    configured !== configured.trim() ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ownedLocal))
  )
    throw new AuthBackendUnavailableError();
  return origin.origin;
}

/** Resolve only trusted configuration before registration can perform a write. */
export function registrationMailOrigin(requestOrigin: string, environment: AuthEnvironment = process.env): string {
  try {
    const configured = environment.BASE_URL?.trim() || environment.NEXTAUTH_URL?.trim();
    if (configured) return trustedOrigin(configured, environment);
    const local = new URL(requestOrigin);
    if (
      !['development', 'test'].includes(environment.NODE_ENV ?? '') ||
      !['localhost', '127.0.0.1', '[::1]'].includes(local.hostname)
    )
      throw new AuthBackendUnavailableError();
    return trustedOrigin(requestOrigin, environment);
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
  let origin: string;
  let secret: string;
  try {
    if (webPasswordMode(environment) !== 'backend-staging') throw new AuthBackendUnavailableError();
    origin = trustedOrigin(environment[AUTH_COMMAND_ENV.origin] ?? '', environment);
    secret = environment[AUTH_COMMAND_ENV.secret] ?? '';
    if (
      secret.trim() !== secret ||
      new TextEncoder().encode(secret).byteLength < 32 ||
      [environment.NEXTAUTH_SECRET, environment.CRON_SECRET].some((other) => !!other && secret === other)
    )
      throw new AuthBackendUnavailableError();
  } catch {
    throw new AuthBackendUnavailableError();
  }
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? AUTH_COMMAND_TIMEOUT_MS;

  async function command(command: AuthCommand): Promise<AuthCommandReply> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const body = JSON.stringify(command);
      if (new TextEncoder().encode(body).byteLength > AUTH_COMMAND_REQUEST_BYTES)
        throw new AuthBackendUnavailableError();
      const operation = async () => {
        const response = await send(`${origin}${AUTH_COMMAND_PATHS[command.operation]}`, {
          method: 'POST',
          redirect: 'error',
          cache: 'no-store',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
          body,
        });
        if (
          response.redirected ||
          !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '') ||
          !response.body
        ) {
          throw new AuthBackendUnavailableError();
        }
        const contentLength = response.headers.get('Content-Length');
        if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > AUTH_COMMAND_RESPONSE_BYTES)) {
          throw new AuthBackendUnavailableError();
        }
        reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let length = 0;
        let json = '';
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > AUTH_COMMAND_RESPONSE_BYTES) throw new AuthBackendUnavailableError();
          json += decoder.decode(chunk.value, { stream: true });
        }
        json += decoder.decode();
        const rawReply: unknown = JSON.parse(json);
        const reply = authCommandReplySchema.parse(rawReply);
        if (
          reply.requestId !== command.requestId ||
          reply.operation !== command.operation ||
          authCommandReplyStatus(reply) !== response.status
        )
          throw new AuthBackendUnavailableError();
        return reply;
      };
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new AuthBackendUnavailableError());
          }, timeoutMs);
        }),
      ]);
    } catch {
      // Never retain a provider body, submitted password, URL, or nested cause.
      throw new AuthBackendUnavailableError();
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => undefined);
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
