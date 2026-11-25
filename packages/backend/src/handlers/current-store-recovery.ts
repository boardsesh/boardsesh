import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import {
  AUTH_PROTOCOL_VERSION,
  RECOVERY_COMMAND_PATHS,
  PASSWORD_RESET_DEVICE_TOKEN_CAPABILITY_HEADER,
  authCommandReplyStatus,
  forgotPasswordReplySchema,
  resetPasswordReplySchema,
  recoveryFamilyForgotCommandSchema,
  recoveryFamilyResetCommandSchema,
} from '@boardsesh/auth-protocol';
import { getCredentialDatabase } from '../auth/credential-database';
import { parseCutoffEnforcement } from '../auth/credential-cutoffs';
import { currentStoreRpcSecret } from '../auth/current-store/authority-configuration';
import { assertFresh, WebPasswordCommandError } from '../auth/current-store/command-context';
import { PRIVATE_AUTH_COMMAND_MS, requirePrivateCommandBudget } from '../auth/current-store/private-command-budget';
import {
  requestRecoveryBeforeEnforcement,
  consumeRecoveryBeforeEnforcement,
} from '../auth/current-store/password-recovery-family';
import { recoveryCommandGuards, type RecoveryCommandGuards } from '../auth/current-store/recovery-command-limits';
import {
  PasswordCompareAbortedError,
  PasswordComparesSaturatedError,
  PASSWORD_COMPARES_RETRY_AFTER_SECONDS,
} from '../auth/current-store/password-compare-gate';
import { RateLimitError } from '../utils/rate-limiter';
import { logger } from '../utils/logger';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';
import { sendJson } from './http-utils';

/** Independent absent/prepared family; no mode can manufacture enforced authority. */
export async function handleCurrentStoreRecovery(
  request: IncomingMessage,
  response: ServerResponse,
  database?: DbInstance,
  guards: RecoveryCommandGuards = recoveryCommandGuards,
): Promise<void> {
  let secret: string;
  try {
    if (process.env.DEBUG_SQL === 'true' || parseCutoffEnforcement(process.env.AUTH_CUTOFF_ENFORCEMENT) !== 'enforce')
      throw new Error('Recovery unavailable');
    secret = currentStoreRpcSecret(process.env);
  } catch {
    sendJson(response, 503, { error: 'disabled' });
    return;
  }
  if (!authenticatesPrivateAuth(request.headers.authorization, secret) || request.headers.origin !== undefined) {
    sendJson(response, 401, { error: 'unauthorized' });
    return;
  }
  if (request.method !== 'POST' || request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const path = new URL(request.url ?? '/', 'http://private.invalid').pathname;
  const operation =
    path === RECOVERY_COMMAND_PATHS['forgot-password']
      ? 'forgot-password'
      : path === RECOVERY_COMMAND_PATHS['reset-password']
        ? 'reset-password'
        : undefined;
  if (!operation) {
    sendJson(response, 404, { error: 'disabled' });
    return;
  }
  let command;
  try {
    const payload = await readPrivateAuthCommand(request);
    const parsed = (
      operation === 'forgot-password' ? recoveryFamilyForgotCommandSchema : recoveryFamilyResetCommandSchema
    ).safeParse(payload);
    if (!parsed.success || parsed.data.operation !== operation) {
      sendJson(response, 400, { error: 'invalid_request' });
      return;
    }
    command = parsed.data;
    assertFresh(command.issuedAt);
  } catch (error) {
    if (!response.destroyed)
      sendJson(response, 400, {
        error: error instanceof WebPasswordCommandError ? 'expired_request' : 'invalid_request',
      });
    return;
  }
  const callerGone = new AbortController();
  response.once('close', () => {
    if (!response.writableFinished) callerGone.abort();
  });
  if (response.destroyed) callerGone.abort();
  const deadline = performance.now() + PRIVATE_AUTH_COMMAND_MS;
  const base = {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation,
    requestId: command.requestId,
    outcome: 'error',
  } as const;
  const execute = async () => {
    const admission = await guards.limits[operation].admit({ clientAddress: command.clientAddress });
    const work = guards.work(operation, admission.source);
    if (work.isFull()) throw new PasswordComparesSaturatedError();
    // Every admitted recovery command counts, including absent accounts and bad links.
    // A response timeout never releases this slot until its real work settles.
    return work.run(async () => {
      requirePrivateCommandBudget(deadline);
      const credentials = database ?? (await getCredentialDatabase('private-recovery-v1'));
      requirePrivateCommandBudget(deadline);
      const reply =
        command.operation === 'forgot-password'
          ? forgotPasswordReplySchema.parse(await requestRecoveryBeforeEnforcement(credentials, command, deadline))
          : resetPasswordReplySchema.parse(
              await consumeRecoveryBeforeEnforcement(credentials, command, {
                deadline,
                issueDeviceToken: request.headers[PASSWORD_RESET_DEVICE_TOKEN_CAPABILITY_HEADER] === '1',
              }),
            );
      requirePrivateCommandBudget(deadline);
      return reply;
    }, callerGone.signal);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      execute(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Recovery unavailable')), PRIVATE_AUTH_COMMAND_MS);
      }),
    ]);
    sendJson(response, authCommandReplyStatus(reply), reply);
  } catch (error) {
    if (error instanceof PasswordCompareAbortedError) return;
    if (error instanceof WebPasswordCommandError) {
      sendJson(response, 400, { error: 'expired_request' });
      return;
    }
    if (error instanceof RateLimitError) {
      const retryAfterSeconds = Math.max(1, error.retryAfterSeconds);
      sendJson(
        response,
        429,
        { ...base, code: 'rate_limited', retryAfterSeconds },
        { 'Retry-After': String(retryAfterSeconds) },
      );
      return;
    }
    if (error instanceof PasswordComparesSaturatedError) {
      sendJson(
        response,
        503,
        { ...base, code: 'unavailable' },
        { 'Retry-After': String(PASSWORD_COMPARES_RETRY_AFTER_SECONDS) },
      );
      return;
    }
    logger.warn('[RecoveryAuth] Command unavailable', { category: 'credential-service' });
    sendJson(response, 503, { ...base, code: 'unavailable' });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
