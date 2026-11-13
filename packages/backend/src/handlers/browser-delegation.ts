import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import {
  BROWSER_DELEGATION_COMMAND_PATH,
  BROWSER_DELEGATION_PROTOCOL_VERSION,
  BROWSER_DELEGATION_REQUEST_BYTES,
  BROWSER_DELEGATION_RESPONSE_BYTES,
  browserDelegationCommandSchema,
  browserDelegationReplySchema,
  browserDelegationReplyStatus,
  type BrowserDelegationReply,
} from '@boardsesh/auth-protocol/browser-delegation-v1';
import { issueBrowserDelegation } from '../auth/authority/browser-delegation';
import {
  currentStoreAuthorityConfiguration,
  currentStoreRpcSecret,
} from '../auth/current-store/authority-configuration';
import { isWebPasswordCommandFresh } from '../auth/current-store/web-password';
import { getCredentialDatabase } from '../auth/credential-database';
import { checkRateLimit } from '../utils/rate-limiter';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';
import { sendJson } from './http-utils';

/** No public cookies, no caller-asserted session facts and no general content
 * connection. This service endpoint remains dark with the browser mode. */
export async function handleBrowserDelegation(
  request: IncomingMessage,
  response: ServerResponse,
  database?: DbInstance,
): Promise<void> {
  response.setHeader('Cache-Control', 'private, no-store');
  let secret: string;
  let authority: ReturnType<typeof currentStoreAuthorityConfiguration>;
  try {
    if (browserBindingMode(process.env) !== 'backend-staging') {
      sendJson(response, 404, { error: 'disabled' });
      return;
    }
    secret = currentStoreRpcSecret(process.env);
    authority = currentStoreAuthorityConfiguration(process.env);
  } catch {
    sendJson(response, 503, { error: 'unavailable' });
    return;
  }
  if (!authenticatesPrivateAuth(request.headers.authorization, secret)) {
    sendJson(response, 401, { error: 'unauthorized' });
    return;
  }
  if (
    request.method !== 'POST' ||
    request.url?.split('?')[0] !== BROWSER_DELEGATION_COMMAND_PATH ||
    request.headers['content-type']?.split(';')[0].trim() !== 'application/json'
  ) {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const parsed = browserDelegationCommandSchema.safeParse(
    await readPrivateAuthCommand(request, BROWSER_DELEGATION_REQUEST_BYTES).catch(() => undefined),
  );
  if (!parsed.success || !isWebPasswordCommandFresh(parsed.data.issuedAt)) {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const command = parsed.data;
  const metadata = {
    browserDelegationProtocolVersion: BROWSER_DELEGATION_PROTOCOL_VERSION,
    operation: 'delegate' as const,
    requestId: command.requestId,
  };
  try {
    checkRateLimit('browser-binding:delegate', 600, 60_000);
    const credential = command.payload.actor.credential;
    const proof =
      credential.kind === 'legacy-jwe' ? { ...credential, secret: process.env.NEXTAUTH_SECRET ?? '' } : credential;
    const result = await issueBrowserDelegation(
      database ?? (await getCredentialDatabase('private-browser-v1')),
      authority,
      {
        bindingToken: command.payload.bindingToken,
        actor: { version: command.payload.actor.version, credential: proof },
      },
    );
    const reply: BrowserDelegationReply = browserDelegationReplySchema.parse(
      result.status === 'admitted'
        ? {
            ...metadata,
            outcome: 'admitted',
            token: result.token,
            issuedAt: result.issuedAt.toISOString(),
            expiresAt: result.expiresAt.toISOString(),
            cursor: { ...result.cursor, bindingExpiresAt: result.cursor.bindingExpiresAt.toISOString() },
            userId: result.session.userId,
            authSessionId: result.session.authSessionId,
          }
        : { ...metadata, outcome: result.status },
    );
    if (Buffer.byteLength(JSON.stringify(reply), 'utf8') > BROWSER_DELEGATION_RESPONSE_BYTES)
      throw new Error('BROWSER_DELEGATION_REPLY_TOO_LARGE');
    sendJson(response, browserDelegationReplyStatus(reply), reply);
  } catch {
    sendJson(response, 503, { ...metadata, outcome: 'unavailable' });
  }
}
