import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AUTH_COMMAND_FUTURE_SKEW_MS,
  AUTH_COMMAND_MAX_AGE_MS,
  GUESS_LIMIT_PATHS,
  GUESS_LIMIT_REQUEST_BYTES,
  guessClearCommandSchema,
  guessGiveBackCommandSchema,
  guessReserveCommandSchema,
  type GuessReservation,
  type GuessReserveReply,
} from '@boardsesh/auth-protocol';
import { currentStoreRpcSecret } from '../auth/current-store/authority-configuration';
import { passwordGuessLimiter, type CountedGuess, type PasswordGuessLimiter } from '../auth/password-guess-limit';
import { logger } from '../utils/logger';
import { sendJson } from './http-utils';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';

/**
 * The web's legacy sign-in reaches the per-account guess limit here (#7656):
 * reserve before its compare, give back after a right password, clear after a
 * completed reset. The web never writes the fenced counter table itself.
 * Dark until `AUTH_ACCOUNT_GUESS_LIMIT_MODE` is on and the web calls it.
 */
export async function handleGuessLimitCommand(
  request: IncomingMessage,
  response: ServerResponse,
  limiter: PasswordGuessLimiter = passwordGuessLimiter(),
): Promise<void> {
  let rpcSecret: string;
  try {
    rpcSecret = currentStoreRpcSecret(process.env);
  } catch {
    sendJson(response, 404, { error: 'disabled' });
    return;
  }
  if (limiter.mode === 'off') {
    sendJson(response, 404, { error: 'disabled' });
    return;
  }
  if (!authenticatesPrivateAuth(request.headers.authorization, rpcSecret) || request.headers.origin !== undefined) {
    sendJson(response, 401, { error: 'unauthorized' });
    return;
  }
  if (request.method !== 'POST' || request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const path = new URL(request.url ?? '/', 'http://private.invalid').pathname;
  const schema =
    path === GUESS_LIMIT_PATHS.reserve
      ? guessReserveCommandSchema
      : path === GUESS_LIMIT_PATHS['give-back']
        ? guessGiveBackCommandSchema
        : path === GUESS_LIMIT_PATHS.clear
          ? guessClearCommandSchema
          : undefined;
  if (!schema) {
    sendJson(response, 404, { error: 'disabled' });
    return;
  }
  let body: unknown;
  try {
    body = await readPrivateAuthCommand(request, GUESS_LIMIT_REQUEST_BYTES);
  } catch {
    if (!response.destroyed) sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const command = parsed.data;
  const age = Date.now() - command.issuedAt;
  if (age > AUTH_COMMAND_MAX_AGE_MS || age < -AUTH_COMMAND_FUTURE_SKEW_MS) {
    sendJson(response, 400, { error: 'expired_request' });
    return;
  }
  try {
    if (command.operation === 'reserve') {
      const admission = await limiter.admit({
        email: command.email,
        deviceToken: command.deviceToken,
        candidateUserId: command.candidateUserId,
      });
      const reply: GuessReserveReply =
        admission.outcome === 'refused'
          ? { outcome: 'refused', retryAfterSeconds: admission.retryAfterSeconds }
          : {
              outcome: 'proceed',
              ...(admission.counted ? { reservation: toWire(admission.counted) } : {}),
              ...(admission.wouldRefuse ? { wouldRefuse: true } : {}),
            };
      sendJson(response, 200, reply);
      return;
    }
    if (command.operation === 'give-back')
      await limiter.settleCounted(
        command.email,
        command.reservation ? fromWire(command.reservation) : undefined,
        command.verdict,
        command.wouldRefuse === true,
      );
    else await limiter.clearEmail(command.email);
    sendJson(response, 200, { outcome: 'done' });
  } catch {
    // The limiter fails open by itself; nothing about the command is logged.
    logger.warn('[PasswordGuess] Guess limit command unavailable', { operation: command.operation });
    sendJson(response, 503, { error: 'unavailable' });
  }
}

function toWire(counted: CountedGuess): GuessReservation {
  return {
    id: counted.id,
    bucket: counted.bucket,
    ...(counted.userId ? { userId: counted.userId } : {}),
    windows: counted.windows.map(({ kind, start }) => ({ kind, start: start.toISOString() })),
  };
}

function fromWire(reservation: GuessReservation): CountedGuess {
  return {
    id: reservation.id,
    bucket: reservation.bucket,
    ...(reservation.userId ? { userId: reservation.userId } : {}),
    windows: reservation.windows.map(({ kind, start }) => ({ kind, start: new Date(start) })),
  };
}
