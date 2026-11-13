import { assertWebSessionWriterConfiguration } from '../auth/current-store/web-session-configuration';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import { AUTH_PROTOCOL_VERSION, webSignOutMode, webSignOutCommandSchema } from '@boardsesh/auth-protocol';
import { getCredentialDatabase } from '../auth/credential-database';
import {
  currentStoreAuthorityConfiguration,
  currentStoreRpcSecret,
} from '../auth/current-store/authority-configuration';
import { isWebPasswordCommandFresh } from '../auth/current-store/web-password';
import { signOutLegacyWebSession } from '../auth/authority/web-signout';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';
import { sendJson } from './http-utils';

/** Private service-authenticated transport, independent of mirror/cohort modes. */
export async function handleCurrentStoreWebSignOut(
  request: IncomingMessage,
  response: ServerResponse,
  database?: DbInstance,
): Promise<void> {
  let secret: string;
  try {
    if (webSignOutMode(process.env) !== 'backend-staging') {
      sendJson(response, 404, { error: 'disabled' });
      return;
    }
    assertWebSessionWriterConfiguration();
    secret = currentStoreRpcSecret(process.env);
  } catch {
    sendJson(response, 503, { error: 'unavailable' });
    return;
  }
  if (!authenticatesPrivateAuth(request.headers.authorization, secret)) {
    sendJson(response, 401, { error: 'unauthorized' });
    return;
  }
  if (request.method !== 'POST' || request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const parsed = webSignOutCommandSchema.safeParse(await readPrivateAuthCommand(request).catch(() => undefined));
  if (!parsed.success || !isWebPasswordCommandFresh(parsed.data.issuedAt)) {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const { requestId, payload } = parsed.data;
  const base = { protocolVersion: AUTH_PROTOCOL_VERSION, operation: 'signout' as const, requestId };
  try {
    const sessionSecret = process.env.NEXTAUTH_SECRET;
    if (!sessionSecret) throw new Error('Session authority unavailable');
    const commandDatabase = database ?? (await getCredentialDatabase());
    const result = await signOutLegacyWebSession(commandDatabase, payload.credential, sessionSecret, new Date(), () =>
      currentStoreAuthorityConfiguration(process.env),
    );
    if (result.status !== 'signed-out') throw new Error('Session authority unavailable or lineage unproven');
    // The service acknowledges already-ended login ancestry idempotently.
    sendJson(response, 200, { ...base, outcome: 'signed_out' });
  } catch {
    sendJson(response, 503, { ...base, outcome: 'error', code: 'unavailable' });
  }
}
