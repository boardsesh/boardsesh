import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import {
  AUTH_COMMAND_ENV,
  AUTH_COMMAND_PATHS,
  AUTH_COMMAND_REQUEST_BYTES,
  authCommandReplyStatus,
  parseWebAuthMode,
  passwordCommandSchema,
  passwordReplySchema,
  registerCommandSchema,
  registerReplySchema,
  type AuthCommand,
} from '@boardsesh/auth-protocol';
import { db } from '../db/client';
import { CURRENT_EMAIL_NORMALIZER_VERSION } from '../auth/current-store/foundation-context';
import {
  authenticateWebPassword,
  isWebPasswordCommandFresh,
  registerWebPassword,
  WebPasswordCommandError,
  type WebPasswordAuthority,
} from '../auth/current-store/web-password';
import { checkRateLimit, RateLimitError } from '../utils/rate-limiter';
import { logger } from '../utils/logger';
import { readJsonBody, sendJson } from './http-utils';

type Environment = Readonly<Record<string, string | undefined>>;

export function currentStoreWebAuthConfiguration(
  environment: Environment = process.env,
):
  | { readonly mode: 'legacy' }
  | { readonly mode: 'backend-staging'; readonly rpcSecret: string; readonly authority: WebPasswordAuthority } {
  const mode = parseWebAuthMode(environment[AUTH_COMMAND_ENV.mode]);
  if (mode === 'legacy') return { mode };
  // The shared client's DEBUG_SQL logger prints bound parameters, including
  // bcrypt hashes and verification secrets. Never run staged auth through it.
  if (environment.DEBUG_SQL === 'true') throw new Error('Unsafe current-store auth SQL logging');
  const rpcSecret = environment[AUTH_COMMAND_ENV.secret];
  const projectionId = environment.CURRENT_STORE_AUTH_PROJECTION_ID;
  const epochText = environment.CURRENT_STORE_AUTH_WRITER_EPOCH;
  if (
    !rpcSecret ||
    rpcSecret !== rpcSecret.trim() ||
    Buffer.byteLength(rpcSecret, 'utf8') < 32 ||
    [environment.NEXTAUTH_SECRET, environment.CRON_SECRET].some(
      (secret) => Boolean(secret?.trim()) && secret === rpcSecret,
    ) ||
    !projectionId ||
    projectionId !== projectionId.trim() ||
    projectionId.length > 256 ||
    !epochText ||
    !/^[1-9]\d*$/.test(epochText) ||
    !Number.isSafeInteger(Number(epochText)) ||
    Number(epochText) > 2_147_483_647
  )
    throw new Error('Invalid current-store web auth configuration');
  return {
    mode,
    rpcSecret,
    authority: {
      expectedProjectionId: projectionId,
      expectedNormalizerVersion: CURRENT_EMAIL_NORMALIZER_VERSION,
      expectedWriterEpoch: Number(epochText),
      emailVerificationEnabled: environment.EMAIL_VERIFICATION_ENABLED === 'true',
    },
  };
}

function authenticates(presented: string | undefined, secret: string) {
  const actual = Buffer.from(presented ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readCommand(request: IncomingMessage): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const text = await Promise.race([
      readJsonBody(request, AUTH_COMMAND_REQUEST_BYTES),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          request.destroy();
          reject(new Error('Private auth request deadline'));
        }, 2000);
      }),
    ]);
    return JSON.parse(text);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  if (!authenticates(request.headers.authorization, configuration.rpcSecret) || request.headers.origin !== undefined) {
    sendJson(response, 401, { error: 'unauthorized' });
    return;
  }
  if (request.method !== 'POST' || request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const path = new URL(request.url ?? '/', 'http://private.invalid').pathname;
  const operation =
    path === AUTH_COMMAND_PATHS.register ? 'register' : path === AUTH_COMMAND_PATHS.password ? 'password' : undefined;
  if (!operation) {
    sendJson(response, 404, { error: 'disabled' });
    return;
  }
  let command: AuthCommand;
  try {
    const parsed = (operation === 'register' ? registerCommandSchema : passwordCommandSchema).safeParse(
      await readCommand(request),
    );
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
    // Process-wide service budget, in addition to retained web per-IP limits.
    // This is not claimed as distributed production abuse protection.
    checkRateLimit(`current-store-web-auth:${operation}`, operation === 'register' ? 60 : 180, 60_000);
    const result =
      command.operation === 'register'
        ? registerReplySchema.parse(await registerWebPassword(database, configuration.authority, command))
        : passwordReplySchema.parse(await authenticateWebPassword(database, configuration.authority, command));
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
    sendJson(response, 503, { operation, requestId: command.requestId, outcome: 'error', code: 'unavailable' });
  }
}
