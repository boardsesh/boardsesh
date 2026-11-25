import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import {
  AUTH_PROTOCOL_VERSION,
  PRE_ENFORCEMENT_PASSWORD_PATH,
  preEnforcementPasswordCommandSchema,
  preEnforcementPasswordReplySchema,
  authCommandReplyStatus,
} from '@boardsesh/auth-protocol';
import { parseCutoffEnforcement } from '../auth/credential-cutoffs';
import { currentStoreRpcSecret } from '../auth/current-store/authority-configuration';
import { assertFresh, WebPasswordCommandError } from '../auth/current-store/command-context';
import {
  PASSWORD_LOGIN_COMMAND_MS,
  requirePasswordLoginBudget,
  authenticatePasswordBeforeEnforcement,
} from '../auth/current-store/password-login-family';
import {
  passwordCompareGate,
  PasswordCompareAbortedError,
  PasswordComparesSaturatedError,
  PASSWORD_COMPARES_RETRY_AFTER_SECONDS,
} from '../auth/current-store/password-compare-gate';
import {
  preEnforcementPasswordLoginLimiter,
  type PasswordLoginAttempt,
} from '../auth/current-store/password-login-limits';
import { passwordGuessLimiter, type PasswordGuessAdmission } from '../auth/password-guess-limit';
import type { StagedSignInGuards } from './current-store-web-auth';
import { getCredentialDatabase } from '../auth/credential-database';
import { RateLimitError } from '../utils/rate-limiter';
import { logger } from '../utils/logger';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';
import { sendJson } from './http-utils';

/** Independent of staged authority modes. Its actual context permits absent/prepared only. */
export async function handleCurrentStorePasswordLogin(
  request: IncomingMessage,
  response: ServerResponse,
  database?: DbInstance,
  guards: StagedSignInGuards = { limits: preEnforcementPasswordLoginLimiter, gate: passwordCompareGate },
): Promise<void> {
  let secret: string;
  try {
    if (process.env.DEBUG_SQL === 'true' || parseCutoffEnforcement(process.env.AUTH_CUTOFF_ENFORCEMENT) !== 'enforce')
      throw new Error('Password authentication unavailable');
    secret = currentStoreRpcSecret(process.env);
  } catch {
    sendJson(response, 503, { error: 'disabled' });
    return;
  }
  if (!authenticatesPrivateAuth(request.headers.authorization, secret) || request.headers.origin !== undefined) {
    sendJson(response, 401, { error: 'unauthorized' });
    return;
  }
  if (new URL(request.url ?? '/', 'http://private.invalid').pathname !== PRE_ENFORCEMENT_PASSWORD_PATH) {
    sendJson(response, 404, { error: 'disabled' });
    return;
  }
  if (request.method !== 'POST' || request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  let command;
  try {
    const parsed = preEnforcementPasswordCommandSchema.safeParse(await readPrivateAuthCommand(request));
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
  const base = {
    protocolVersion: AUTH_PROTOCOL_VERSION,
    operation: 'password',
    requestId: command.requestId,
    outcome: 'error',
  } as const;
  const policy = { emailVerificationEnabled: process.env.EMAIL_VERIFICATION_ENABLED === 'true' };
  const deadline = performance.now() + PASSWORD_LOGIN_COMMAND_MS;
  const execute = async () => {
    let attempt: PasswordLoginAttempt | undefined;
    let guess: Extract<PasswordGuessAdmission, { outcome: 'proceed' }> | undefined;
    try {
      if (guards.gate.isFull()) throw new PasswordComparesSaturatedError();
      attempt = await guards.limits.admit({ clientAddress: command.clientAddress });
      // Bound the whole command, including pool acquisition and snapshots. A
      // disconnected active caller retains its slot until the real work settles.
      const reply = await guards.gate.run(async () => {
        let admission: PasswordGuessAdmission;
        try {
          admission = await passwordGuessLimiter().admit({
            email: command.payload.email,
            deviceToken: command.deviceToken,
          });
        } catch {
          admission = { outcome: 'proceed', settle: async () => {} };
        }
        if (admission.outcome === 'refused') throw new RateLimitError(admission.retryAfterSeconds);
        guess = admission;
        requirePasswordLoginBudget(deadline);
        const credentials = database ?? (await getCredentialDatabase('private-registration-v1'));
        requirePasswordLoginBudget(deadline);
        return preEnforcementPasswordReplySchema.parse(
          await authenticatePasswordBeforeEnforcement(credentials, policy, command, deadline),
        );
      }, callerGone.signal);
      if (reply.outcome !== 'invalid_credentials') await attempt.giveBack();
      const settling = guess;
      guess = undefined;
      await settling?.settle(
        reply.outcome === 'invalid_credentials'
          ? 'rejected'
          : reply.outcome === 'authenticated'
            ? 'accepted'
            : 'no_verdict',
      );
      return reply;
    } catch (error) {
      await attempt?.giveBack();
      await guess?.settle('no_verdict');
      throw error;
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      execute(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Password authentication unavailable')), PASSWORD_LOGIN_COMMAND_MS);
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
    logger.warn('[PasswordAuth] Command unavailable', { category: 'credential-service' });
    sendJson(response, 503, { ...base, code: 'unavailable' });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
