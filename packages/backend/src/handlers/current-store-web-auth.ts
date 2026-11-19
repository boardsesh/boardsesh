import { setWebPassword } from '../auth/current-store/set-password';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import {
  setPasswordMode,
  setPasswordCommandSchema,
  AUTH_COMMAND_ENV,
  AUTH_COMMAND_PATHS,
  PASSWORD_RESET_DEVICE_TOKEN_CAPABILITY_HEADER,
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
  webSessionMode,
  type AuthCommand,
} from '@boardsesh/auth-protocol';
import { getCredentialDatabase } from '../auth/credential-database';
import { databaseErrorCode } from '../auth/current-store/database-error-code';
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
import {
  passwordCompareGate,
  PasswordCompareAbortedError,
  PasswordComparesSaturatedError,
  PASSWORD_COMPARES_RETRY_AFTER_SECONDS,
  type PasswordCompareGate,
} from '../auth/current-store/password-compare-gate';
import {
  passwordLoginLimiter,
  type PasswordLoginAttempt,
  type PasswordLoginLimiter,
} from '../auth/current-store/password-login-limits';
import { passwordGuessLimiter, type PasswordGuessAdmission } from '../auth/password-guess-limit';
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

/** The password command's per-client limiter and compare gate. Tests pass their own. */
export interface StagedSignInGuards {
  readonly limits: PasswordLoginLimiter;
  readonly gate: PasswordCompareGate;
}

const processSignInGuards: StagedSignInGuards = { limits: passwordLoginLimiter, gate: passwordCompareGate };

/** Default-off private service transport. No CORS/cookie/public-token authority. */
export async function handleCurrentStoreWebAuth(
  request: IncomingMessage,
  response: ServerResponse,
  database?: DbInstance,
  signInGuards: StagedSignInGuards = processSignInGuards,
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
                : path === AUTH_COMMAND_PATHS['set-password']
                  ? 'set-password'
                  : undefined;
  if (!operation) {
    sendJson(response, 404, { error: 'disabled' });
    return;
  }
  try {
    if (operation === 'set-password' && setPasswordMode(process.env) !== 'backend-staging') {
      sendJson(response, 404, { error: 'disabled' });
      return;
    }
  } catch {
    sendJson(response, 503, { error: 'disabled' });
    return;
  }
  let command: Exclude<AuthCommand, { operation: 'signout' }>;
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
                : operation === 'set-password'
                  ? setPasswordCommandSchema
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
  // A login that asks for a web session needs its own mode, checked before any
  // limiter key, bcrypt or database work.
  if (command.operation === 'password' && command.webSession !== undefined) {
    // A session is never issued without the proof that gives its legacy
    // rollback cookie the same session id (#7596 B5a review, M1).
    if (command.credentialProofVersion === undefined) {
      sendJson(response, 400, { error: 'invalid_request' });
      return;
    }
    try {
      if (webSessionMode(process.env) !== 'backend-staging') {
        sendJson(response, 404, { error: 'disabled' });
        return;
      }
    } catch {
      sendJson(response, 503, { error: 'disabled' });
      return;
    }
    // A legacy cookie can only be read with NEXTAUTH_SECRET. Without it the
    // answer is unavailable whatever the password, and no attempt is spent.
    if (command.webSession.presented?.kind === 'legacy-jwe' && !process.env.NEXTAUTH_SECRET) {
      sendJson(response, 503, {
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'password',
        requestId: command.requestId,
        outcome: 'error',
        code: 'unavailable',
      });
      return;
    }
  }
  let passwordAttempt: PasswordLoginAttempt | undefined;
  let guess: Extract<PasswordGuessAdmission, { outcome: 'proceed' }> | undefined;
  // A sign-in still waiting for its compare when the web server gives up is dropped unrun.
  const callerGone = new AbortController();
  response.once('close', () => {
    if (!response.writableFinished) callerGone.abort();
  });
  if (response.destroyed) callerGone.abort();
  try {
    if (command.operation === 'password') {
      const { limits, gate } = signInGuards;
      // Shed before creating any Redis key or reading the database.
      if (gate.isFull()) throw new PasswordComparesSaturatedError();
      // The per-client limit, shared through Redis. A sign-in with no public
      // client address takes the per-process budget instead (180 a minute).
      passwordAttempt = await limits.admit({ clientAddress: command.clientAddress });
      // The per-account guess limit (#7656), after the per-client one. Its
      // refusal is the same rate_limited reply, for a known or unknown address.
      let admission: PasswordGuessAdmission;
      try {
        admission = await passwordGuessLimiter().admit({
          email: command.payload.email,
          deviceToken: command.deviceToken,
        });
      } catch {
        // The limiter fails open by itself; this only guards a programming error, as native does.
        admission = { outcome: 'proceed', settle: async () => {} };
      }
      if (admission.outcome === 'refused') throw new RateLimitError(admission.retryAfterSeconds);
      guess = admission;
    } else {
      // Process-wide backstop behind the web route's per-client limits, which do
      // the real work: the backend only ever sees the web server as its peer.
      // This is not claimed as distributed production abuse protection.
      checkRateLimit(`current-store-web-auth:${operation}`, operation === 'register' ? 60 : 180, 60_000);
    }
    const commandDatabase = database ?? (await getCredentialDatabase());
    const result = authCommandReplySchema.parse(
      command.operation === 'register'
        ? await registerWebPassword(commandDatabase, configuration.authority, command)
        : command.operation === 'password'
          ? await authenticateWebPassword(commandDatabase, configuration.authority, command, (compares) =>
              signInGuards.gate.run(compares, callerGone.signal),
            )
          : command.operation === 'verify-email'
            ? await consumeEmailVerification(commandDatabase, configuration.authority, command)
            : command.operation === 'resend-verification'
              ? await resendEmailVerification(commandDatabase, configuration.authority, command)
              : command.operation === 'forgot-password'
                ? await requestPasswordRecovery(commandDatabase, configuration.authority, command)
                : command.operation === 'set-password'
                  ? await setWebPassword(commandDatabase, configuration.authority, command)
                  : await consumePasswordRecovery(commandDatabase, configuration.authority, command, {
                      issueDeviceToken: request.headers[PASSWORD_RESET_DEVICE_TOKEN_CAPABILITY_HEADER] === '1',
                    }),
    );
    // Only a rejected password stays counted; a right one never uses up a limit.
    if (!(result.operation === 'password' && result.outcome === 'invalid_credentials')) {
      await passwordAttempt?.giveBack();
    }
    if (result.operation === 'password') {
      const settling = guess;
      // Settled once: a failure after this point must not give back a rejected guess.
      guess = undefined;
      await settling?.settle(
        result.outcome === 'invalid_credentials'
          ? 'rejected'
          : result.outcome === 'authenticated'
            ? 'accepted'
            : 'no_verdict',
      );
    }
    sendJson(response, authCommandReplyStatus(result), result);
  } catch (error) {
    // No verdict was reached, so the attempt is not counted.
    await passwordAttempt?.giveBack();
    await guess?.settle('no_verdict');
    // Nobody is left to answer.
    if (error instanceof PasswordCompareAbortedError) return;
    if (error instanceof PasswordComparesSaturatedError) {
      sendJson(
        response,
        503,
        {
          protocolVersion: AUTH_PROTOCOL_VERSION,
          operation,
          requestId: command.requestId,
          outcome: 'error',
          code: 'unavailable',
        },
        { 'Retry-After': String(PASSWORD_COMPARES_RETRY_AFTER_SECONDS) },
      );
      return;
    }
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
    const sqlState = databaseErrorCode(error);
    logger.warn('Current-store web authentication command unavailable', {
      operation,
      ...(sqlState ? { sqlState } : {}),
    });
    sendJson(response, 503, {
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation,
      requestId: command.requestId,
      outcome: 'error',
      code: 'unavailable',
    });
  }
}
