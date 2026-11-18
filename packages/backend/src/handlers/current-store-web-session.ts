import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import {
  WEB_SESSION_COMMAND_PATHS,
  WEB_SESSION_PROTOCOL_VERSION,
  webSessionAccessCommandSchema,
  webSessionAccessReplySchema,
  webSessionBridgeCommandSchema,
  webSessionBridgeReplySchema,
  webSessionMode,
  webSessionReadCommandSchema,
  webSessionReadReplySchema,
  webSessionReplyStatus,
  webSessionSignOutCommandSchema,
  webSessionSignOutReplySchema,
  type WebSessionAccessReply,
  type WebSessionBridgeReply,
  type WebSessionReadReply,
  type WebSessionSignOutCommand,
  type WebSessionSignOutReply,
} from '@boardsesh/auth-protocol';
import { getCredentialDatabase } from '../auth/credential-database';
import { databaseErrorCode } from '../auth/current-store/database-error-code';
import {
  currentStoreAuthorityConfiguration,
  currentStoreRpcSecret,
} from '../auth/current-store/authority-configuration';
import { isWebPasswordCommandFresh } from '../auth/current-store/command-context';
import type { ExpectedCurrentStoreAuthority } from '../auth/current-store/foundation-context';
import {
  browserAccessTokenKeyFromEnvironment,
  bridgeTokenKeyFromEnvironment,
  legacyBridgeUntil,
} from '../auth/authority/browser-session-mode';
import {
  accessWebSession,
  bridgeWebSession,
  presentedWebCredential,
  profileDisplayReader,
  readWebSession,
  type ProfileDisplayReader,
  signOutWebSession,
  type WebSessionSignOut,
} from '../auth/authority/web-session';
import { logger } from '../utils/logger';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';
import { sendJson } from './http-utils';

const COMMAND_SCHEMAS = {
  session: webSessionReadCommandSchema,
  signout: webSessionSignOutCommandSchema,
  bridge: webSessionBridgeCommandSchema,
  access: webSessionAccessCommandSchema,
} as const;
type WebSessionOperation = keyof typeof COMMAND_SCHEMAS;

function operationAt(path: string): WebSessionOperation | undefined {
  return (Object.keys(WEB_SESSION_COMMAND_PATHS) as WebSessionOperation[]).find(
    (operation) => WEB_SESSION_COMMAND_PATHS[operation] === path,
  );
}

/** Both sign-out bodies: the first form's bare token is a canonical one. */
function signOutRequest(payload: WebSessionSignOutCommand['payload']): WebSessionSignOut {
  const { expectedUserId, expectedAuthSessionId } = payload;
  const credential =
    'token' in payload
      ? presentedWebCredential({ kind: 'canonical-token', token: payload.token })
      : presentedWebCredential(payload.presented);
  return { credential, expectedUserId, expectedAuthSessionId };
}

/**
 * The bridge's secrets. Missing or invalid ones make the command unavailable
 * (503), never a denial: a denial tells www to drop the legacy cookie.
 */
function bridgeKeys() {
  const nextAuthSecret = process.env.NEXTAUTH_SECRET;
  if (!nextAuthSecret) throw new Error('Web session authority unavailable');
  return { nextAuthSecret, tokenKey: bridgeTokenKeyFromEnvironment(process.env) };
}

/**
 * Default-off private commands for the first-party web session (#7596):
 * session read, guarded sign-out, the legacy cookie bridge and the browser
 * access token (which is where a session rolls). Login is the staged password
 * command with `webSession`. No CORS, cookie or public token reaches these,
 * and no reply sets a cookie: www owns the cookie.
 */
/**
 * The session read's profile fields, on the backend's ordinary application
 * connection. Loaded on first use, so a test that injects its own database
 * never builds the shared one; a failure to load it answers without a profile.
 */
const applicationProfileDisplay: ProfileDisplayReader = async (userId) => {
  try {
    const { db } = await import('../db/client');
    return await profileDisplayReader(db)(userId);
  } catch {
    return undefined;
  }
};

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
  const operation = operationAt(path);
  if (!operation) {
    sendJson(response, 404, { error: 'disabled' });
    return;
  }
  const body = await readPrivateAuthCommand(request).catch(() => undefined);
  const parsed = COMMAND_SCHEMAS[operation].safeParse(body);
  if (!parsed.success || !isWebPasswordCommandFresh(parsed.data.issuedAt)) {
    if (!response.destroyed) sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const command = parsed.data;
  const base = { webSessionProtocolVersion: WEB_SESSION_PROTOCOL_VERSION, requestId: command.requestId };
  try {
    const commandDatabase = database ?? (await getCredentialDatabase());
    let reply: WebSessionReadReply | WebSessionSignOutReply | WebSessionBridgeReply | WebSessionAccessReply;
    if (command.operation === 'session') {
      // Reads only: nothing is rolled, bridged or stamped.
      // The profile's display fields come from the application connection: the
      // credential LOGIN may not read user_profiles, and they are cosmetic.
      const read = await readWebSession(
        commandDatabase,
        presentedWebCredential(command.payload.presented),
        new Date(),
        database ? profileDisplayReader(database) : applicationProfileDisplay,
      );
      reply = webSessionReadReplySchema.parse(
        read.status === 'active'
          ? {
              ...base,
              operation: 'session',
              outcome: 'active',
              userId: read.session.userId,
              authSessionId: read.session.authSessionId,
              generation: read.session.generation,
              expiresAt: read.session.expiresAt.toISOString(),
              // Absent means unknown, which never counts as a login.
              source: read.session.source ?? 'bridge',
              authenticatedAt: read.session.authenticatedAt?.toISOString() ?? null,
              linkGuarded: read.session.linkGuarded,
              user: read.user,
            }
          : { ...base, operation: 'session', outcome: 'unauthenticated' },
      );
    } else if (command.operation === 'signout') {
      const outcome = await signOutWebSession(commandDatabase, signOutRequest(command.payload), authority);
      reply = webSessionSignOutReplySchema.parse({
        ...base,
        operation: 'signout',
        outcome: outcome === 'signed-out' ? 'signed_out' : 'identity_changed',
      });
    } else if (command.operation === 'access') {
      // A missing or reused signing secret is unavailable (503), never a signed-out answer.
      const tokenKey = browserAccessTokenKeyFromEnvironment(process.env);
      const access = await accessWebSession(commandDatabase, command.payload.presented, tokenKey);
      reply = webSessionAccessReplySchema.parse(
        access.status === 'active'
          ? {
              ...base,
              operation: 'access',
              outcome: 'active',
              userId: access.session.userId,
              authSessionId: access.session.authSessionId,
              expiresAt: access.session.expiresAt.toISOString(),
              rolled: access.rolled,
              accessToken: access.accessToken,
              accessTokenExpiresAt: access.accessTokenExpiresAt.toISOString(),
            }
          : { ...base, operation: 'access', outcome: 'unauthenticated', reason: access.reason },
      );
    } else {
      // After AUTH_LEGACY_BRIDGE_UNTIL the bridge is over: denied, nothing read or written.
      // Unset or not a time throws here and answers 503, never a denial: no open-ended bridge.
      const until = legacyBridgeUntil(process.env);
      if (until === undefined) throw new Error('Web bridge has no end date');
      const bridged =
        Date.now() >= until.getTime()
          ? ({ status: 'denied' } as const)
          : await bridgeWebSession(commandDatabase, command.payload.credential, bridgeKeys(), authority);
      reply = webSessionBridgeReplySchema.parse(
        bridged.status === 'bridged'
          ? {
              ...base,
              operation: 'bridge',
              outcome: 'bridged',
              userId: bridged.userId,
              sessionId: bridged.sessionId,
              token: bridged.token,
              expiresAt: bridged.expiresAt.toISOString(),
              generation: bridged.generation,
            }
          : { ...base, operation: 'bridge', outcome: 'denied' },
      );
    }
    sendJson(response, webSessionReplyStatus(reply), reply);
  } catch (error) {
    // Database errors can carry the bound token. Log a fixed category and the
    // SQLSTATE only, never the message, SQL text or parameters.
    const sqlState = databaseErrorCode(error);
    logger.warn('Current-store web session command unavailable', { operation, ...(sqlState ? { sqlState } : {}) });
    sendJson(response, 503, { ...base, operation, outcome: 'error', code: 'unavailable' });
  }
}
