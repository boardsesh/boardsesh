import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import {
  BROWSER_RENEWAL_COMMAND_PATHS,
  BROWSER_RENEWAL_REQUEST_BYTES,
  BROWSER_RENEWAL_RESPONSE_BYTES,
  browserRenewalCommandSchema,
  browserRenewalReplySchema,
  browserRenewalReplyStatus,
} from '@boardsesh/auth-protocol/browser-renewal-v1';
import { browserRenewalConfiguration } from '../auth/authority/browser-renewal-configuration';
import { executeBrowserRenewalCommand } from '../auth/authority/browser-renewal';
import { isWebPasswordCommandFresh } from '../auth/current-store/command-context';
import { getCredentialDatabase } from '../auth/credential-database';
import { checkRateLimit } from '../utils/rate-limiter';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';
import { sendJson } from './http-utils';

/** Strict service-only transport. A caller cannot choose identity, credential
 * age, cookie publication or a content-pool fallback through HTTP metadata. */
export async function handleBrowserRenewal(
  request: IncomingMessage,
  response: ServerResponse,
  database?: DbInstance,
): Promise<void> {
  response.setHeader('Cache-Control', 'private, no-store');
  let configuration: ReturnType<typeof browserRenewalConfiguration>;
  try {
    configuration = browserRenewalConfiguration();
  } catch {
    sendJson(response, 503, { error: 'unavailable' });
    return;
  }
  if (configuration.mode !== 'backend-staging') {
    sendJson(response, 404, { error: 'disabled' });
    return;
  }
  if (!authenticatesPrivateAuth(request.headers.authorization, configuration.rpcSecret)) {
    sendJson(response, 401, { error: 'unauthorized' });
    return;
  }
  if (request.method !== 'POST' || request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const parsed = browserRenewalCommandSchema.safeParse(
    await readPrivateAuthCommand(request, BROWSER_RENEWAL_REQUEST_BYTES).catch(() => undefined),
  );
  if (!parsed.success || request.url !== BROWSER_RENEWAL_COMMAND_PATHS[parsed.data.operation]) {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const command = parsed.data;
  if (!isWebPasswordCommandFresh(command.issuedAt)) {
    sendJson(response, 400, { error: 'expired_request' });
    return;
  }
  try {
    if (command.payload.actor.credential.kind === 'legacy-jwe' && !configuration.runtime.legacySecret)
      throw new Error('Legacy renewal source reader is unavailable');
    checkRateLimit(`browser-renewal:${command.operation}`, command.operation === 'prepare' ? 60 : 180, 60_000);
    const commandDatabase = database ?? (await getCredentialDatabase('private-browser-renewal-v1'));
    const reply = browserRenewalReplySchema.parse(
      await executeBrowserRenewalCommand(commandDatabase, configuration.runtime, command),
    );
    if (Buffer.byteLength(JSON.stringify(reply)) > BROWSER_RENEWAL_RESPONSE_BYTES)
      throw new Error('Renewal response exceeds budget');
    sendJson(response, browserRenewalReplyStatus(reply), reply);
  } catch {
    sendJson(response, 503, {
      browserRenewalProtocolVersion: 1,
      requestId: command.requestId,
      operation: command.operation,
      outcome: 'unavailable',
    });
  }
}
