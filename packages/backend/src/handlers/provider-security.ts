import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import {
  PROVIDER_SECURITY_COMMAND_PATHS,
  PROVIDER_SECURITY_REQUEST_BYTES,
  PROVIDER_SECURITY_RESPONSE_BYTES,
  PROVIDER_SECURITY_VERSION,
  providerSecurityCommandSchema,
  providerSecurityReplySchema,
  providerSecurityReplyStatus,
} from '@boardsesh/auth-protocol';
import { providerSecurityConfiguration } from '../auth/authority/provider-security-configuration';
import { executeProviderSecurityCommand } from '../auth/authority/provider-security-commands';
import { isWebPasswordCommandFresh } from '../auth/current-store/command-context';
import { getCredentialDatabase } from '../auth/credential-database';
import { checkRateLimit } from '../utils/rate-limiter';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';
import { sendJson } from './http-utils';

/** Default-off service transport. Browser credentials cannot authenticate the
 * service, and provider commands never fall back to the content database. */
export async function handleProviderSecurity(
  request: IncomingMessage,
  response: ServerResponse,
  database?: DbInstance,
): Promise<void> {
  response.setHeader('Cache-Control', 'private, no-store');
  let configuration: ReturnType<typeof providerSecurityConfiguration>;
  try {
    configuration = providerSecurityConfiguration();
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
  const parsed = providerSecurityCommandSchema.safeParse(
    await readPrivateAuthCommand(request, PROVIDER_SECURITY_REQUEST_BYTES).catch(() => undefined),
  );
  if (!parsed.success) {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const command = parsed.data;
  if (request.url?.split('?')[0] !== PROVIDER_SECURITY_COMMAND_PATHS[command.operation]) {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  if (!isWebPasswordCommandFresh(Date.parse(command.issuedAt))) {
    sendJson(response, 400, { error: 'expired_request' });
    return;
  }
  try {
    checkRateLimit(`provider-security:${command.operation}`, 180, 60_000);
    const commandDatabase = database ?? (await getCredentialDatabase('private-provider-v1'));
    const reply = providerSecurityReplySchema.parse(
      await executeProviderSecurityCommand(commandDatabase, configuration.runtime, command),
    );
    if (Buffer.byteLength(JSON.stringify(reply), 'utf8') > PROVIDER_SECURITY_RESPONSE_BYTES)
      throw new Error('Provider reply exceeds its private transport budget');
    sendJson(response, providerSecurityReplyStatus(reply), reply);
  } catch {
    sendJson(response, 503, {
      providerSecurityVersion: PROVIDER_SECURITY_VERSION,
      operation: command.operation,
      requestId: command.requestId,
      outcome: 'unavailable',
      code: 'authority_unavailable',
    });
  }
}
