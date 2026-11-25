import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import {
  AUTH_PROTOCOL_VERSION,
  SET_PASSWORD_COMPATIBILITY_PATH,
  SET_PASSWORD_COMPATIBILITY_REQUEST_BYTES,
  setPasswordCompatibilityCommandSchema,
  setPasswordCompatibilityReplySchema,
  setPasswordCompatibilityReplyStatus,
  type SetPasswordCompatibilityCommand,
} from '@boardsesh/auth-protocol';
import { getCredentialDatabase } from '../auth/credential-database';
import { assertFresh, WebPasswordCommandError } from '../auth/current-store/command-context';
import { PRIVATE_AUTH_COMMAND_MS, requirePrivateCommandBudget } from '../auth/current-store/private-command-budget';
import {
  captureSetPasswordCompatibilityScope,
  revalidateSetPasswordCompatibilityScope,
} from '../auth/current-store/set-password-compatibility-scope';
import { setPasswordBeforeEnforcement } from '../auth/current-store/set-password-compatibility';
import {
  setPasswordCompatibilityGuards,
  type SetPasswordCompatibilityGuards,
} from '../auth/current-store/set-password-compatibility-limits';
import {
  PasswordCompareAbortedError,
  PasswordComparesSaturatedError,
  PASSWORD_COMPARES_RETRY_AFTER_SECONDS,
} from '../auth/current-store/password-compare-gate';
import { RateLimitError } from '../utils/rate-limiter';
import { logger } from '../utils/logger';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';
import { sendJson } from './http-utils';

/** Default-only private writer; no caller-selected modes, authority or source metadata. */
export async function handleCurrentStoreSetPasswordCompatibility(
  request: IncomingMessage,
  response: ServerResponse,
  database?: DbInstance,
  guards: SetPasswordCompatibilityGuards = setPasswordCompatibilityGuards,
): Promise<void> {
  let scope: ReturnType<typeof captureSetPasswordCompatibilityScope>;
  try {
    scope = captureSetPasswordCompatibilityScope();
  } catch {
    sendJson(response, 503, { error: 'disabled' });
    return;
  }
  if (
    !authenticatesPrivateAuth(request.headers.authorization, scope.rpcSecret) ||
    request.headers.origin !== undefined
  ) {
    sendJson(response, 401, { error: 'unauthorized' });
    return;
  }
  if (new URL(request.url ?? '/', 'http://private.invalid').pathname !== SET_PASSWORD_COMPATIBILITY_PATH) {
    sendJson(response, 404, { error: 'disabled' });
    return;
  }
  if (request.method !== 'POST' || request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  let command: SetPasswordCompatibilityCommand;
  try {
    const parsed = setPasswordCompatibilityCommandSchema.safeParse(
      await readPrivateAuthCommand(request, SET_PASSWORD_COMPATIBILITY_REQUEST_BYTES),
    );
    if (!parsed.success) {
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
    operation: 'set-password',
    requestId: command.requestId,
    outcome: 'error',
  } as const;
  const execute = async () => {
    const admission = await guards.limits.admit({ clientAddress: command.clientAddress });
    const gate = guards.work(admission.source);
    return gate.run(async () => {
      revalidateSetPasswordCompatibilityScope(scope);
      requirePrivateCommandBudget(deadline);
      const credentials =
        database ??
        (await getCredentialDatabase(
          scope.evidenceEnabled ? 'private-registration-evidence-v1' : 'private-registration-v1',
        ));
      requirePrivateCommandBudget(deadline);
      revalidateSetPasswordCompatibilityScope(scope);
      return setPasswordCompatibilityReplySchema.parse(
        await setPasswordBeforeEnforcement(credentials, command, scope, { deadline, signal: callerGone.signal }),
      );
    }, callerGone.signal);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      execute(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Set-password unavailable')), PRIVATE_AUTH_COMMAND_MS);
      }),
    ]);
    sendJson(response, setPasswordCompatibilityReplyStatus(reply), reply);
  } catch (error) {
    if (error instanceof PasswordCompareAbortedError) return;
    if (error instanceof RateLimitError) {
      const retryAfterSeconds = Math.min(60, Math.max(1, error.retryAfterSeconds));
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
    logger.warn('[SetPasswordCompatibility] Command unavailable', { category: 'credential-service' });
    sendJson(response, 503, { ...base, code: 'unavailable' });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
