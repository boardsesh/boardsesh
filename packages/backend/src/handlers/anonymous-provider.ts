import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import {
  ANONYMOUS_PROVIDER_PATHS,
  ANONYMOUS_PROVIDER_REQUEST_BYTES,
  ANONYMOUS_PROVIDER_RESPONSE_BYTES,
  anonymousProviderCommandSchema,
  anonymousProviderReplySchema,
  anonymousProviderReplyStatus,
} from '@boardsesh/auth-protocol';
import { executeAnonymousProviderCommand } from '../auth/authority/anonymous-provider-signin';
import { providerSecurityConfiguration } from '../auth/authority/provider-security-configuration';
import { getCredentialDatabase } from '../auth/credential-database';
import { isWebPasswordCommandFresh } from '../auth/current-store/command-context';
import { checkRateLimit } from '../utils/rate-limiter';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';
import { sendJson } from './http-utils';

/** Private service transport only. Its strict source-free protocol cannot
 * interpret a missing signed-in actor or a caller UID as anonymous admission. */
export async function handleAnonymousProvider(
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
  const parsed = anonymousProviderCommandSchema.safeParse(
    await readPrivateAuthCommand(request, ANONYMOUS_PROVIDER_REQUEST_BYTES).catch(() => undefined),
  );
  if (!parsed.success) {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  const command = parsed.data;
  if (request.url?.split('?')[0] !== ANONYMOUS_PROVIDER_PATHS[command.operation]) {
    sendJson(response, 400, { error: 'invalid_request' });
    return;
  }
  if (!isWebPasswordCommandFresh(Date.parse(command.issuedAt))) {
    sendJson(response, 400, { error: 'expired_request' });
    return;
  }
  try {
    checkRateLimit(`anonymous-provider:${command.operation}`, 180, 60_000);
    const commandDatabase = database ?? (await getCredentialDatabase('private-provider-v1'));
    const reply = anonymousProviderReplySchema.parse(
      await executeAnonymousProviderCommand(commandDatabase, configuration.runtime, command),
    );
    if (Buffer.byteLength(JSON.stringify(reply)) > ANONYMOUS_PROVIDER_RESPONSE_BYTES)
      throw new Error('Anonymous provider reply budget exceeded');
    sendJson(response, anonymousProviderReplyStatus(reply), reply);
  } catch {
    sendJson(response, 503, {
      anonymousProviderVersion: 1,
      requestId: command.requestId,
      operation: command.operation,
      outcome: 'unavailable',
      code: 'authority_unavailable',
    });
  }
}
