import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import {
  WEB_OAUTH_COMMAND_PATHS,
  parseWebAuthMode,
  webOAuthCommandSchema,
  webOAuthReplySchema,
  webOAuthReplyStatus,
} from '@boardsesh/auth-protocol';
import { db } from '../db/client';
import {
  currentStoreAuthorityConfiguration,
  currentStoreRpcSecret,
} from '../auth/current-store/authority-configuration';
import { isWebPasswordCommandFresh, WebPasswordCommandError } from '../auth/current-store/command-context';
import { recordWebOAuthIntent, resolveWebOAuthIdentity } from '../auth/current-store/web-oauth-identity';
import { checkRateLimit, RateLimitError } from '../utils/rate-limiter';
import { logger } from '../utils/logger';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';
import { sendJson } from './http-utils';

type Environment = Readonly<Record<string, string | undefined>>;
export function currentStoreWebOAuthConfiguration(environment: Environment = process.env) {
  const mode = parseWebAuthMode(environment.CURRENT_STORE_WEB_OAUTH_MODE);
  if (mode === 'legacy') return { mode } as const;
  const authority = currentStoreAuthorityConfiguration(environment);
  const rpcSecret = currentStoreRpcSecret(environment);
  const nextAuthSecret = environment.NEXTAUTH_SECRET;
  if (!nextAuthSecret) throw new Error('Missing web OAuth actor key');
  return { mode, authority, rpcSecret, nextAuthSecret } as const;
}

/** Authenticated web assertion only; never accepts a browser-supplied user ID. */
export async function handleCurrentStoreWebOAuth(
  request: IncomingMessage,
  response: ServerResponse,
  database: DbInstance = db,
) {
  let configuration: ReturnType<typeof currentStoreWebOAuthConfiguration>;
  try {
    configuration = currentStoreWebOAuthConfiguration();
  } catch {
    sendJson(response, 503, { error: 'unavailable' });
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
  const operation =
    request.url === WEB_OAUTH_COMMAND_PATHS.intent
      ? 'intent'
      : request.url === WEB_OAUTH_COMMAND_PATHS.resolve
        ? 'resolve'
        : undefined;
  if (!operation) {
    sendJson(response, 404, { error: 'disabled' });
    return;
  }
  if (request.method !== 'POST' || request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  let command: ReturnType<typeof webOAuthCommandSchema.parse>;
  try {
    const parsed = webOAuthCommandSchema.safeParse(await readPrivateAuthCommand(request));
    if (!parsed.success || parsed.data.operation !== operation) {
      sendJson(response, 400, { error: 'invalid_request' });
      return;
    }
    command = parsed.data;
  } catch {
    if (!response.destroyed) sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  if (!isWebPasswordCommandFresh(Date.parse(command.issuedAt))) {
    sendJson(response, 400, { error: 'expired_request' });
    return;
  }
  try {
    checkRateLimit(`current-store-web-oauth:${operation}`, 180, 60_000);
    const result =
      command.operation === 'intent'
        ? await recordWebOAuthIntent(database, configuration.authority, configuration.nextAuthSecret, command)
        : await resolveWebOAuthIdentity(database, configuration.authority, configuration.nextAuthSecret, command);
    if (result.outcome === 'unavailable') {
      sendJson(response, 503, { error: 'unavailable' });
      return;
    }
    const reply = webOAuthReplySchema.parse(result);
    sendJson(response, webOAuthReplyStatus(reply), reply);
  } catch (error) {
    if (error instanceof WebPasswordCommandError) {
      sendJson(response, 400, { error: 'expired_request' });
      return;
    }
    const headers =
      error instanceof RateLimitError ? { 'Retry-After': String(Math.max(1, error.retryAfterSeconds)) } : undefined;
    logger.warn('Current-store web OAuth identity unavailable', { operation });
    sendJson(response, 503, { error: 'unavailable' }, headers);
  }
}
