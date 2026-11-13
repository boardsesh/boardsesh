import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DbInstance } from '@boardsesh/db/client';
import {
  LOCATION_SYNC_COMMAND_PATH,
  LOCATION_SYNC_REQUEST_BYTES,
  LOCATION_SYNC_COMMAND_TIMEOUT_MS,
  locationSyncCommandSchema,
  locationSyncReplyStatus,
  type LocationSyncReply,
} from '@boardsesh/auth-protocol';
import { db } from '../db/client';
import { currentStoreLocationSyncConfiguration } from '../auth/current-store/authority-configuration';
import { LocationSyncCommandError, executeLocationSyncCommand } from '../auth/current-store/location-sync';
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

/** Complete location batches only; browser cookies and human RPC secrets do not authorize it. */
export async function handleCurrentStoreLocationSync(
  request: IncomingMessage,
  response: ServerResponse,
  database: DbInstance = db,
  environment: Environment = process.env,
): Promise<void> {
  const deadlineAt = performance.now() + LOCATION_SYNC_COMMAND_TIMEOUT_MS;
  const rejectBeforeCommand = (status: number, error: string) => {
    if (!response.destroyed) sendJson(response, status, { error }, privateHeaders);
  };
  let configuration: ReturnType<typeof currentStoreLocationSyncConfiguration>;
  try {
    configuration = currentStoreLocationSyncConfiguration(environment);
  } catch {
    rejectBeforeCommand(503, 'unavailable');
    return;
  }
  if (configuration.mode === 'legacy') {
    rejectBeforeCommand(404, 'disabled');
    return;
  }
  if (request.url !== LOCATION_SYNC_COMMAND_PATH) {
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
  let command: ReturnType<typeof locationSyncCommandSchema.parse>;
  try {
    const parsed = locationSyncCommandSchema.safeParse(
      await readPrivateAuthCommand(request, LOCATION_SYNC_REQUEST_BYTES),
    );
    if (!parsed.success) {
      rejectBeforeCommand(400, 'invalid_request');
      return;
    }
    command = parsed.data;
  } catch {
    rejectBeforeCommand(400, 'invalid_request');
    return;
  }
  const metadata = { protocolVersion: 1, operation: 'apply', requestId: command.requestId } as const;
  let reply: LocationSyncReply;
  try {
    checkRateLimit('current-store-location-sync:apply', 60, 60_000);
    const summary = await executeLocationSyncCommand(database, configuration.authority, command, deadlineAt);
    reply = { ...metadata, outcome: 'applied', summary };
  } catch (error) {
    if (error instanceof LocationSyncCommandError) {
      reply = { ...metadata, outcome: 'rejected', code: error.code };
    } else {
      logger.warn('[auth] Location-sync authority unavailable', { category: 'authority-or-database' });
      reply = { ...metadata, outcome: 'rejected', code: 'unavailable' };
    }
  }
  if (!response.destroyed) sendJson(response, locationSyncReplyStatus(reply), reply, privateHeaders);
}
