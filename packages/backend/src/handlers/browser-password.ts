import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import {
  BROWSER_PASSWORD_COMMAND_PATHS,
  BROWSER_PASSWORD_REQUEST_BYTES,
  BROWSER_PASSWORD_RESPONSE_BYTES,
  browserPasswordCommandSchema,
  browserPasswordReplySchema,
  browserPasswordReplyStatus,
} from '@boardsesh/auth-protocol/browser-password-v1';
import { browserPasswordConfiguration } from '../auth/authority/browser-password-configuration';
import { executeBrowserPasswordCommand } from '../auth/authority/browser-password';
import { isWebPasswordCommandFresh } from '../auth/current-store/command-context';
import { getCredentialDatabase } from '../auth/credential-database';
import { checkRateLimit } from '../utils/rate-limiter';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';
import { sendJson } from './http-utils';

/** Authenticated private staging adapter only; public callback ownership is separate. */
export async function handleBrowserPassword(
  request: IncomingMessage,
  response: ServerResponse,
  database?: DbInstance,
): Promise<void> {
  response.setHeader('Cache-Control', 'private, no-store');
  let configuration: ReturnType<typeof browserPasswordConfiguration>;
  try {
    configuration = browserPasswordConfiguration();
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
  const parsed = browserPasswordCommandSchema.safeParse(
    await readPrivateAuthCommand(request, BROWSER_PASSWORD_REQUEST_BYTES).catch(() => undefined),
  );
  if (!parsed.success || request.url !== BROWSER_PASSWORD_COMMAND_PATHS[parsed.data.operation]) {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const command = parsed.data;
  if (!isWebPasswordCommandFresh(command.issuedAt)) {
    sendJson(response, 400, { error: 'expired_request' });
    return;
  }
  try {
    checkRateLimit(`browser-password:${command.operation}`, command.operation === 'prepare' ? 60 : 180, 60_000);
    const commandDatabase = database ?? (await getCredentialDatabase(configuration.requiredContract));
    const reply = browserPasswordReplySchema.parse(
      await executeBrowserPasswordCommand(commandDatabase, configuration.runtime, command),
    );
    if (Buffer.byteLength(JSON.stringify(reply)) > BROWSER_PASSWORD_RESPONSE_BYTES)
      throw new Error('Browser password response exceeds budget');
    sendJson(response, browserPasswordReplyStatus(reply), reply);
  } catch {
    sendJson(response, 503, {
      browserPasswordProtocolVersion: 1,
      requestId: command.requestId,
      operation: command.operation,
      outcome: 'unavailable',
    });
  }
}
