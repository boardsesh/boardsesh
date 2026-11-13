import { randomUUID } from 'node:crypto';
import {
  LOCATION_SYNC_COMMAND_ENV,
  LOCATION_SYNC_COMMAND_PATH,
  LOCATION_SYNC_CLIENT_TIMEOUT_MS,
  LOCATION_SYNC_REQUEST_BYTES,
  LOCATION_SYNC_RESPONSE_BYTES,
  currentStoreLocationSyncMode,
  locationSyncCommandSchema,
  locationSyncReplySchema,
  locationSyncReplyStatus,
  type LocationSyncWireRecord,
} from '@boardsesh/auth-protocol';
import { AuthBackendUnavailableError, createPrivateAuthCommandTransport } from '@boardsesh/auth-protocol/transport';
import type { LocationBatchWriter, PublicBoardLocationInput } from '@boardsesh/location-sync';

type Environment = Readonly<Record<string, string | undefined>>;
const wireCoordinate = (coordinate: number): number | 'NaN' | 'Infinity' | '-Infinity' =>
  Number.isFinite(coordinate)
    ? coordinate
    : Number.isNaN(coordinate)
      ? 'NaN'
      : coordinate > 0
        ? 'Infinity'
        : '-Infinity';

/** Explicit projection excludes provider-only catalog fields such as layoutName. */
function wireRecord(record: PublicBoardLocationInput): LocationSyncWireRecord {
  return {
    boardType: record.boardType as LocationSyncWireRecord['boardType'],
    layoutId: record.layoutId,
    sizeId: record.sizeId,
    setIds: record.setIds,
    angle: record.angle,
    isAngleAdjustable: record.isAngleAdjustable,
    sourceKey: record.sourceKey,
    gymSourceKey: record.gymSourceKey,
    name: record.name,
    slugBase: record.slugBase,
    locationName: record.locationName,
    latitude: wireCoordinate(record.latitude),
    longitude: wireCoordinate(record.longitude),
    gymName: record.gymName,
    gymAddress: record.gymAddress,
    serialNumber: record.serialNumber,
  };
}

/** Bound only by dispatcher to the claimed attempt, outside any worker SQL transaction. */
export function createLocationBatchWriter(options: {
  runId: string;
  attemptToken: string;
  signal: AbortSignal;
  environment?: Environment;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): LocationBatchWriter | undefined {
  const environment = { ...(options.environment ?? process.env) };
  if (currentStoreLocationSyncMode(environment) === 'legacy') return undefined;
  const runId = options.runId;
  const attemptToken = options.attemptToken;
  const signal = options.signal;
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? LOCATION_SYNC_CLIENT_TIMEOUT_MS;
  let transport: ReturnType<typeof createPrivateAuthCommandTransport> | undefined;
  const prepare = () => {
    if (transport) return;
    if (environment.CURRENT_STORE_FIXED_SYSTEM_OWNER_ORDER_MODE !== 'cooperative-staging')
      throw new AuthBackendUnavailableError();
    transport = createPrivateAuthCommandTransport({
      environment,
      fetch: send,
      timeoutMs,
      requestBytes: LOCATION_SYNC_REQUEST_BYTES,
      responseBytes: LOCATION_SYNC_RESPONSE_BYTES,
      originKey: LOCATION_SYNC_COMMAND_ENV.origin,
      secretKey: LOCATION_SYNC_COMMAND_ENV.secret,
      disallowedSecretKeys: [
        'NEXTAUTH_SECRET',
        'CRON_SECRET',
        'CURRENT_STORE_AUTH_RPC_SECRET',
        'CURRENT_STORE_BATCH_SYSTEM_USERS_RPC_SECRET',
        'CURRENT_STORE_DELETED_EMAIL_KEY',
      ],
      paths: [LOCATION_SYNC_COMMAND_PATH],
    });
  };
  const writer: LocationBatchWriter = async (records) => {
    try {
      signal.throwIfAborted();
      prepare();
      if (!transport) throw new AuthBackendUnavailableError();
      const command = locationSyncCommandSchema.parse({
        protocolVersion: 1,
        operation: 'apply',
        requestId: randomUUID(),
        issuedAt: Date.now(),
        payload: { runId, attemptToken, records: records.map(wireRecord) },
      });
      const response = await transport.post(LOCATION_SYNC_COMMAND_PATH, command);
      const reply = locationSyncReplySchema.parse(response.body);
      if (
        reply.requestId !== command.requestId ||
        reply.operation !== command.operation ||
        locationSyncReplyStatus(reply) !== response.status ||
        reply.outcome !== 'applied'
      )
        throw new AuthBackendUnavailableError();
      signal.throwIfAborted();
      return reply.summary;
    } catch {
      // A lost reply may have committed. Never retry here or fall back to worker SQL.
      throw new AuthBackendUnavailableError();
    }
  };
  writer.prepare = prepare;
  return writer;
}
