import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import {
  FIRST_PASSWORD_COMMAND_PATHS,
  FIRST_PASSWORD_REQUEST_BYTES,
  FIRST_PASSWORD_RESPONSE_BYTES,
  FIRST_PASSWORD_VERSION,
  firstPasswordCommandSchema,
  firstPasswordReplySchema,
  firstPasswordReplyStatus,
} from '@boardsesh/auth-protocol';
import { firstPasswordConfiguration } from '../auth/authority/first-password-configuration';
import { captureFirstPasswordActor } from '../auth/authority/first-password-context';
import { executeFirstPasswordCommand } from '../auth/authority/first-password-commands';
import { isWebPasswordCommandFresh } from '../auth/current-store/command-context';
import { getCredentialDatabase } from '../auth/credential-database';
import { checkRateLimit } from '../utils/rate-limiter';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';
import { sendJson } from './http-utils';

/** Private service-only planning transport; no route delivers email or accepts
 * browser cookies as service credentials, and no content-pool fallback exists. */
export async function handleFirstPassword(
  request: IncomingMessage,
  response: ServerResponse,
  database?: DbInstance,
): Promise<void> {
  response.setHeader('Cache-Control', 'private, no-store');
  let configuration: ReturnType<typeof firstPasswordConfiguration>;
  try {
    configuration = firstPasswordConfiguration();
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
  const parsed = firstPasswordCommandSchema.safeParse(
    await readPrivateAuthCommand(request, FIRST_PASSWORD_REQUEST_BYTES).catch(() => undefined),
  );
  if (!parsed.success) {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const command = parsed.data;
  if (request.url?.split('?')[0] !== FIRST_PASSWORD_COMMAND_PATHS[command.operation]) {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  if (!isWebPasswordCommandFresh(Date.parse(command.issuedAt))) {
    sendJson(response, 400, { error: 'expired_request' });
    return;
  }
  try {
    // Missing source-reader configuration cannot cause pool work. Actual
    // possession is still reverified with the selected authority in the core.
    captureFirstPasswordActor(command.payload.actor, configuration.runtime);
    checkRateLimit(`first-password:${command.operation}`, command.operation === 'prepare' ? 60 : 180, 60_000);
    const commandDatabase = database ?? (await getCredentialDatabase('private-first-password-v1'));
    const reply = firstPasswordReplySchema.parse(
      await executeFirstPasswordCommand(commandDatabase, configuration.runtime, command),
    );
    if (Buffer.byteLength(JSON.stringify(reply), 'utf8') > FIRST_PASSWORD_RESPONSE_BYTES)
      throw new Error('First-password private reply exceeds budget');
    sendJson(response, firstPasswordReplyStatus(reply), reply);
  } catch {
    sendJson(response, 503, {
      firstPasswordVersion: FIRST_PASSWORD_VERSION,
      requestId: command.requestId,
      operation: command.operation,
      outcome: 'unavailable',
      code: 'authority_unavailable',
    });
  }
}
