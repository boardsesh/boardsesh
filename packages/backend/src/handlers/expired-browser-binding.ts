import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import {
  EXPIRED_BROWSER_BINDING_COMMAND_PATHS,
  EXPIRED_BROWSER_BINDING_REQUEST_BYTES,
  EXPIRED_BROWSER_BINDING_RESPONSE_BYTES,
  expiredBrowserBindingCommandSchema,
  expiredBrowserBindingReplySchema,
  expiredBrowserBindingReplyStatus,
} from '@boardsesh/auth-protocol/expired-browser-binding-v1';
import { expiredBrowserBindingConfiguration } from '../auth/authority/expired-browser-binding-configuration';
import { executeExpiredBrowserBindingCommand } from '../auth/authority/expired-browser-binding';
import { isWebPasswordCommandFresh } from '../auth/current-store/command-context';
import { getCredentialDatabase } from '../auth/credential-database';
import { checkRateLimit } from '../utils/rate-limiter';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';
import { sendJson } from './http-utils';

/** Only an authenticated internal adapter may request this explicit flow. No
 * correlation-only request is routed into generic login/logout or source reads. */
export async function handleExpiredBrowserBinding(
  request: IncomingMessage,
  response: ServerResponse,
  database?: DbInstance,
): Promise<void> {
  response.setHeader('Cache-Control', 'private, no-store');
  let configuration: ReturnType<typeof expiredBrowserBindingConfiguration>;
  try {
    configuration = expiredBrowserBindingConfiguration();
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
  const parsed = expiredBrowserBindingCommandSchema.safeParse(
    await readPrivateAuthCommand(request, EXPIRED_BROWSER_BINDING_REQUEST_BYTES).catch(() => undefined),
  );
  if (!parsed.success || request.url !== EXPIRED_BROWSER_BINDING_COMMAND_PATHS[parsed.data.operation]) {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const command = parsed.data;
  if (!isWebPasswordCommandFresh(command.issuedAt)) {
    sendJson(response, 400, { error: 'expired_request' });
    return;
  }
  try {
    checkRateLimit(`expired-browser-binding:${command.operation}`, command.operation === 'prepare' ? 60 : 180, 60_000);
    const commandDatabase = database ?? (await getCredentialDatabase(configuration.requiredContract));
    const reply = expiredBrowserBindingReplySchema.parse(
      await executeExpiredBrowserBindingCommand(commandDatabase, configuration.qualification, command),
    );
    if (Buffer.byteLength(JSON.stringify(reply)) > EXPIRED_BROWSER_BINDING_RESPONSE_BYTES)
      throw new Error('Expired binding response exceeds budget');
    sendJson(response, expiredBrowserBindingReplyStatus(reply), reply);
  } catch {
    sendJson(response, 503, {
      expiredBrowserBindingProtocolVersion: 1,
      requestId: command.requestId,
      operation: command.operation,
      outcome: 'unavailable',
    });
  }
}
