import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import {
  BATCH_SYSTEM_USER_COMMAND_PATH,
  BATCH_SYSTEM_USER_COMMAND_TIMEOUT_MS,
  batchSystemUserCommandSchema,
  batchSystemUserReplyStatus,
  type BatchSystemUserReply,
} from '@boardsesh/auth-protocol';
import { db } from '../db/client';
import { currentStoreBatchSystemUsersConfiguration } from '../auth/current-store/authority-configuration';
import { BatchSystemUserError, executeBatchSystemUserCommand } from '../auth/current-store/batch-system-user';
import { checkRateLimit } from '../utils/rate-limiter';
import { logger } from '../utils/logger';
import { authenticatesPrivateAuth, readPrivateAuthCommand } from './current-store-private-transport';
import { sendJson } from './http-utils';

type Environment = Readonly<Record<string, string | undefined>>;
const privateHeaders = {
  'Cache-Control': 'private, no-store',
  'CDN-Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};

/** Fixed batch accounts only; browser cookies and human RPC secrets do not authorize it. */
export async function handleCurrentStoreBatchSystemUsers(
  request: IncomingMessage,
  response: ServerResponse,
  database: DbInstance = db,
  environment: Environment = process.env,
): Promise<void> {
  const deadlineAt = performance.now() + BATCH_SYSTEM_USER_COMMAND_TIMEOUT_MS;
  const rejectBeforeCommand = (status: number, error: string) => {
    if (!response.destroyed) sendJson(response, status, { error }, privateHeaders);
  };
  let configuration: ReturnType<typeof currentStoreBatchSystemUsersConfiguration>;
  try {
    configuration = currentStoreBatchSystemUsersConfiguration(environment);
  } catch {
    rejectBeforeCommand(503, 'unavailable');
    return;
  }
  if (configuration.mode === 'legacy') {
    rejectBeforeCommand(404, 'disabled');
    return;
  }
  if (request.url !== BATCH_SYSTEM_USER_COMMAND_PATH) {
    rejectBeforeCommand(404, 'unavailable');
    return;
  }
  if (
    request.headers.origin !== undefined ||
    !authenticatesPrivateAuth(request.headers.authorization, configuration.rpcSecret)
  ) {
    rejectBeforeCommand(401, 'unauthorized');
    return;
  }
  if (
    request.method !== 'POST' ||
    request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json' ||
    (request.headers['content-encoding'] !== undefined && request.headers['content-encoding'] !== 'identity')
  ) {
    rejectBeforeCommand(400, 'invalid_request');
    return;
  }
  let command: ReturnType<typeof batchSystemUserCommandSchema.parse>;
  try {
    const parsed = batchSystemUserCommandSchema.safeParse(await readPrivateAuthCommand(request));
    if (!parsed.success) {
      rejectBeforeCommand(400, 'invalid_request');
      return;
    }
    command = parsed.data;
  } catch {
    rejectBeforeCommand(400, 'invalid_request');
    return;
  }
  const metadata = { protocolVersion: 1, operation: 'ensure', requestId: command.requestId } as const;
  let reply: BatchSystemUserReply;
  try {
    checkRateLimit('current-store-batch-system-users:ensure', 180, 60_000);
    await executeBatchSystemUserCommand(database, configuration.authority, command, deadlineAt);
    reply = { ...metadata, outcome: 'ensured' };
  } catch (error) {
    if (error instanceof BatchSystemUserError) {
      reply = { ...metadata, outcome: 'rejected', code: error.code };
    } else {
      logger.warn('[auth] Batch system-user authority unavailable', { category: 'authority-or-database' });
      reply = { ...metadata, outcome: 'rejected', code: 'unavailable' };
    }
  }
  if (!response.destroyed) sendJson(response, batchSystemUserReplyStatus(reply), reply, privateHeaders);
}
