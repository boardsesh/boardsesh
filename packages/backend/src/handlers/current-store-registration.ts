import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import {
  AUTH_PROTOCOL_VERSION,
  REGISTRATION_COMMAND_PATHS,
  authCommandReplySchema,
  authCommandReplyStatus,
  registerCommandSchema,
  resendVerificationCommandSchema,
  verifyEmailCommandSchema,
} from '@boardsesh/auth-protocol';
import { getCredentialDatabase } from '../auth/credential-database';
import { currentStoreRpcSecret } from '../auth/current-store/authority-configuration';
import { isWebPasswordCommandFresh, WebPasswordCommandError } from '../auth/current-store/command-context';
import {
  registerBeforeEnforcement,
  resendBeforeEnforcement,
  verifyBeforeEnforcement,
} from '../auth/current-store/registration-family';
import { checkRateLimit, RateLimitError } from '../utils/rate-limiter';
import { logger } from '../utils/logger';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';
import { sendJson } from './http-utils';

/**
 * Backend-first addition: existing staged paths and old web callers do not
 * change. No projection/config attestation enables this pre-enforcement writer.
 * The actual manifest is checked under its shared gate in every transaction.
 */
export async function handleCurrentStoreRegistration(
  request: IncomingMessage,
  response: ServerResponse,
  database?: DbInstance,
): Promise<void> {
  let secret: string;
  try {
    if (process.env.DEBUG_SQL === 'true') throw new Error('Unsafe credential logging');
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
    path === REGISTRATION_COMMAND_PATHS.register
      ? 'register'
      : path === REGISTRATION_COMMAND_PATHS['verify-email']
        ? 'verify-email'
        : path === REGISTRATION_COMMAND_PATHS['resend-verification']
          ? 'resend-verification'
          : undefined;
  if (!operation) {
    sendJson(response, 404, { error: 'disabled' });
    return;
  }
  const schema =
    operation === 'register'
      ? registerCommandSchema
      : operation === 'verify-email'
        ? verifyEmailCommandSchema
        : resendVerificationCommandSchema;
  let parsed;
  try {
    parsed = schema.safeParse(await readPrivateAuthCommand(request));
  } catch {
    if (!response.destroyed) sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  if (!parsed.success || parsed.data.operation !== operation) {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const command = parsed.data;
  if (!isWebPasswordCommandFresh(command.issuedAt)) {
    sendJson(response, 400, { error: 'expired_request' });
    return;
  }
  try {
    checkRateLimit(`current-store-registration:${operation}`, operation === 'register' ? 60 : 180, 60_000);
    const credentialDatabase = database ?? (await getCredentialDatabase('private-registration-v1'));
    const policy = { emailVerificationEnabled: process.env.EMAIL_VERIFICATION_ENABLED === 'true' };
    const reply = authCommandReplySchema.parse(
      command.operation === 'register'
        ? await registerBeforeEnforcement(credentialDatabase, policy, command)
        : command.operation === 'resend-verification'
          ? await resendBeforeEnforcement(credentialDatabase, command)
          : await verifyBeforeEnforcement(credentialDatabase, command),
    );
    sendJson(response, authCommandReplyStatus(reply), reply);
  } catch (error) {
    if (error instanceof WebPasswordCommandError) {
      sendJson(response, 400, { error: 'expired_request' });
      return;
    }
    const base = {
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation,
      requestId: command.requestId,
      outcome: 'error',
    } as const;
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
    // Neither SQL parameters, errors/causes nor submitted links leave this layer.
    logger.warn('[RegistrationAuth] Command unavailable', { category: 'credential-service' });
    sendJson(response, 503, { ...base, code: 'unavailable' });
  }
}
