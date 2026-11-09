import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import {
  AUTH_COMMAND_ENV,
  AUTH_COMMAND_PATHS,
  AUTH_PROTOCOL_VERSION,
  authCommandReplySchema,
  authCommandReplyStatus,
  parseWebAuthMode,
  passwordCommandSchema,
  registerCommandSchema,
  verifyEmailCommandSchema,
  resendVerificationCommandSchema,
  forgotPasswordCommandSchema,
  resetPasswordCommandSchema,
  type AuthCommand,
} from '@boardsesh/auth-protocol';
import { db } from '../db/client';
import {
  currentStoreAuthorityConfiguration,
  currentStoreRpcSecret,
} from '../auth/current-store/authority-configuration';
import {
  authenticateWebPassword,
  isWebPasswordCommandFresh,
  registerWebPassword,
  WebPasswordCommandError,
  type WebPasswordAuthority,
} from '../auth/current-store/web-password';
import { consumeEmailVerification, resendEmailVerification } from '../auth/current-store/email-verification';
import { consumePasswordRecovery, requestPasswordRecovery } from '../auth/current-store/password-recovery';
import { checkRateLimit, RateLimitError } from '../utils/rate-limiter';
import { logger } from '../utils/logger';
import { sendJson } from './http-utils';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';

type Environment = Readonly<Record<string, string | undefined>>;

export function currentStoreWebAuthConfiguration(
  environment: Environment = process.env,
):
  | { readonly mode: 'legacy' }
  | { readonly mode: 'backend-staging'; readonly rpcSecret: string; readonly authority: WebPasswordAuthority } {
  const mode = parseWebAuthMode(environment[AUTH_COMMAND_ENV.mode]);
  if (mode === 'legacy') return { mode };
  const authority = currentStoreAuthorityConfiguration(environment);
  const rpcSecret = currentStoreRpcSecret(environment);
  return {
    mode,
    rpcSecret,
    authority,
  };
}

/** Default-off private service transport. No CORS/cookie/public-token authority. */
export async function handleCurrentStoreWebAuth(
  request: IncomingMessage,
  response: ServerResponse,
  database: DbInstance = db,
): Promise<void> {
  let configuration: ReturnType<typeof currentStoreWebAuthConfiguration>;
  try {
    configuration = currentStoreWebAuthConfiguration();
  } catch {
    sendJson(response, 503, { error: 'disabled' });
    return;
  }
  if (configuration.mode === 'legacy') {
    sendJson(response, 404, { error: 'disabled' });
    return;
  }
  if (
    !authenticatesPrivateAuth(request.headers.authorization, configuration.rpcSecret) ||
    request.headers.origin !== undefined
  ) {
    sendJson(response, 401, { error: 'unauthorized' });
    return;
  }
  if (request.method !== 'POST' || request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const path = new URL(request.url ?? '/', 'http://private.invalid').pathname;
  const operation =
    path === AUTH_COMMAND_PATHS.register
      ? 'register'
      : path === AUTH_COMMAND_PATHS.password
        ? 'password'
        : path === AUTH_COMMAND_PATHS['verify-email']
          ? 'verify-email'
          : path === AUTH_COMMAND_PATHS['resend-verification']
            ? 'resend-verification'
            : path === AUTH_COMMAND_PATHS['forgot-password']
              ? 'forgot-password'
              : path === AUTH_COMMAND_PATHS['reset-password']
                ? 'reset-password'
                : undefined;
  if (!operation) {
    sendJson(response, 404, { error: 'disabled' });
    return;
  }
  let command: AuthCommand;
  try {
    const parsed = (
      operation === 'register'
        ? registerCommandSchema
        : operation === 'password'
          ? passwordCommandSchema
          : operation === 'verify-email'
            ? verifyEmailCommandSchema
            : operation === 'resend-verification'
              ? resendVerificationCommandSchema
              : operation === 'forgot-password'
                ? forgotPasswordCommandSchema
                : resetPasswordCommandSchema
    ).safeParse(await readPrivateAuthCommand(request));
    if (!parsed.success) {
      sendJson(response, 400, { error: 'invalid_request' });
      return;
    }
    command = parsed.data;
  } catch {
    if (!response.destroyed) sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  if (!isWebPasswordCommandFresh(command.issuedAt)) {
    sendJson(response, 400, { error: 'expired_request' });
    return;
  }
  try {
    // Process-wide backstop behind the web route's per-client limits, which do
    // the real work: the backend only ever sees the web server as its peer.
    // This is not claimed as distributed production abuse protection.
    checkRateLimit(`current-store-web-auth:${operation}`, operation === 'register' ? 60 : 180, 60_000);
    const result = authCommandReplySchema.parse(
      command.operation === 'register'
        ? await registerWebPassword(database, configuration.authority, command)
        : command.operation === 'password'
          ? await authenticateWebPassword(database, configuration.authority, command)
          : command.operation === 'verify-email'
            ? await consumeEmailVerification(database, configuration.authority, command)
            : command.operation === 'resend-verification'
              ? await resendEmailVerification(database, configuration.authority, command)
              : command.operation === 'forgot-password'
                ? await requestPasswordRecovery(database, configuration.authority, command)
                : await consumePasswordRecovery(database, configuration.authority, command),
    );
    sendJson(response, authCommandReplyStatus(result), result);
  } catch (error) {
    if (error instanceof WebPasswordCommandError) {
      sendJson(response, 400, { error: 'expired_request' });
      return;
    }
    if (error instanceof RateLimitError) {
      // The shared limiter can report zero at exact window equality. Private
      // protocol replies require a positive retry delay, including the header.
      const retryAfterSeconds = Math.max(1, error.retryAfterSeconds);
      sendJson(
        response,
        429,
        {
          protocolVersion: AUTH_PROTOCOL_VERSION,
          operation,
          requestId: command.requestId,
          outcome: 'error',
          code: 'rate_limited',
          retryAfterSeconds,
        },
        { 'Retry-After': String(retryAfterSeconds) },
      );
      return;
    }
    // SQL/Sentry/validation exceptions can contain bound credentials or the
    // private mail response. Emit only a fixed category, never the exception.
    logger.warn('Current-store web authentication command unavailable', { operation });
    sendJson(response, 503, {
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation,
      requestId: command.requestId,
      outcome: 'error',
      code: 'unavailable',
    });
  }
}
