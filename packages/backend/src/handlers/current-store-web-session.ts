import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import {
  WEB_SESSION_COMMAND_PATHS,
  WEB_SESSION_PROTOCOL_VERSION,
  webSessionMode,
  webSessionReplyStatus,
  webSessionRollCommandSchema,
  webSessionRollReplySchema,
  webSessionSignOutCommandSchema,
  webSessionSignOutReplySchema,
  type WebSessionRollReply,
  type WebSessionSignOutReply,
} from '@boardsesh/auth-protocol';
import { getCredentialDatabase } from '../auth/credential-database';
import {
  currentStoreAuthorityConfiguration,
  currentStoreRpcSecret,
} from '../auth/current-store/authority-configuration';
import { isWebPasswordCommandFresh } from '../auth/current-store/command-context';
import type { ExpectedCurrentStoreAuthority } from '../auth/current-store/foundation-context';
import { refreshWebSession, signOutWebSession } from '../auth/authority/web-session';
import { logger } from '../utils/logger';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';
import { sendJson } from './http-utils';

/**
 * Default-off private commands for the first-party web session (#7596):
 * guarded sign-out and roll. Login is the staged password command with
 * `webSession`. No CORS, cookie or public token reaches these.
 */
export async function handleCurrentStoreWebSession(
  request: IncomingMessage,
  response: ServerResponse,
  database?: DbInstance,
): Promise<void> {
  let rpcSecret: string;
  let authority: ExpectedCurrentStoreAuthority;
  try {
    if (webSessionMode(process.env) !== 'backend-staging') {
      sendJson(response, 404, { error: 'disabled' });
      return;
    }
    rpcSecret = currentStoreRpcSecret(process.env);
    authority = currentStoreAuthorityConfiguration(process.env);
  } catch {
    sendJson(response, 503, { error: 'unavailable' });
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
  const operation =
    path === WEB_SESSION_COMMAND_PATHS.signout
      ? 'signout'
      : path === WEB_SESSION_COMMAND_PATHS.roll
        ? 'roll'
        : undefined;
  if (!operation) {
    sendJson(response, 404, { error: 'disabled' });
    return;
  }
  const body = await readPrivateAuthCommand(request).catch(() => undefined);
  const parsed = (operation === 'signout' ? webSessionSignOutCommandSchema : webSessionRollCommandSchema).safeParse(
    body,
  );
  if (!parsed.success || !isWebPasswordCommandFresh(parsed.data.issuedAt)) {
    if (!response.destroyed) sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const command = parsed.data;
  const base = { webSessionProtocolVersion: WEB_SESSION_PROTOCOL_VERSION, requestId: command.requestId };
  try {
    const commandDatabase = database ?? (await getCredentialDatabase());
    let reply: WebSessionSignOutReply | WebSessionRollReply;
    if (command.operation === 'signout') {
      const outcome = await signOutWebSession(commandDatabase, command.payload, authority);
      reply = webSessionSignOutReplySchema.parse({
        ...base,
        operation: 'signout',
        outcome: outcome === 'signed-out' ? 'signed_out' : 'identity_changed',
      });
    } else {
      const refreshed = await refreshWebSession(commandDatabase, command.payload.token);
      reply = webSessionRollReplySchema.parse(
        refreshed.status === 'active'
          ? {
              ...base,
              operation: 'roll',
              outcome: 'active',
              userId: refreshed.session.userId,
              authSessionId: refreshed.session.authSessionId,
              expiresAt: refreshed.expiresAt.toISOString(),
              rolled: refreshed.rolled,
            }
          : { ...base, operation: 'roll', outcome: 'unauthenticated' },
      );
    }
    sendJson(response, webSessionReplyStatus(reply), reply);
  } catch {
    // Database errors can carry the bound token. Log a fixed category only.
    logger.warn('Current-store web session command unavailable', { operation });
    sendJson(response, 503, { ...base, operation, outcome: 'error', code: 'unavailable' });
  }
}
