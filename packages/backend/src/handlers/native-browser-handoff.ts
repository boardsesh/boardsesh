import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import { browserBindingMode } from '@boardsesh/auth-protocol/browser-binding-v1';
import {
  NATIVE_BROWSER_HANDOFF_COMMAND_PATH,
  NATIVE_BROWSER_HANDOFF_PROTOCOL_VERSION,
  NATIVE_BROWSER_HANDOFF_REQUEST_BYTES,
  NATIVE_BROWSER_HANDOFF_RESPONSE_BYTES,
  nativeBrowserHandoffCommandSchema,
  nativeBrowserHandoffReplySchema,
  nativeBrowserHandoffReplyStatus,
  type NativeBrowserHandoffReply,
} from '@boardsesh/auth-protocol/native-browser-handoff-v1';
import { issueNativeBrowserHandoff } from '../auth/authority/native-browser-handoff';
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
export async function handleNativeBrowserHandoffIssue(
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
    request.url?.split('?')[0] !== NATIVE_BROWSER_HANDOFF_COMMAND_PATH ||
    request.headers['content-type']?.split(';')[0].trim() !== 'application/json'
  ) {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const parsed = nativeBrowserHandoffCommandSchema.safeParse(
    await readPrivateAuthCommand(request, NATIVE_BROWSER_HANDOFF_REQUEST_BYTES).catch(() => undefined),
  );
  if (!parsed.success || !isWebPasswordCommandFresh(parsed.data.issuedAt)) {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const command = parsed.data;
  const metadata = {
    nativeBrowserHandoffProtocolVersion: NATIVE_BROWSER_HANDOFF_PROTOCOL_VERSION,
    operation: 'issue' as const,
    requestId: command.requestId,
  };
  try {
    checkRateLimit('native-browser-handoff:issue', 600, 60_000);
    const credential = command.payload.actor.credential;
    const proof =
      credential.kind === 'legacy-jwe' ? { ...credential, secret: process.env.NEXTAUTH_SECRET ?? '' } : credential;
    const result = await issueNativeBrowserHandoff(
      database ?? (await getCredentialDatabase('private-browser-v1')),
      authority,
      {
        bindingToken: command.payload.bindingToken,
        actor: { version: command.payload.actor.version, credential: proof },
        ...(command.payload.providerSignin ? { providerSignin: command.payload.providerSignin } : {}),
      },
    );
    const reply: NativeBrowserHandoffReply = nativeBrowserHandoffReplySchema.parse(
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
    if (Buffer.byteLength(JSON.stringify(reply), 'utf8') > NATIVE_BROWSER_HANDOFF_RESPONSE_BYTES)
      throw new Error('NATIVE_BROWSER_HANDOFF_REPLY_TOO_LARGE');
    sendJson(response, nativeBrowserHandoffReplyStatus(reply), reply);
  } catch {
    sendJson(response, 503, { ...metadata, outcome: 'unavailable' });
  }
}
