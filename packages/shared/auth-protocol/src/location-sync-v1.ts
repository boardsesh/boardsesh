import { z } from 'zod';

export const LOCATION_SYNC_COMMAND_PATH = '/api/internal/auth/current-store/location-sync/v1/apply';
export const LOCATION_SYNC_COMMAND_TIMEOUT_MS = 25_000;
export const LOCATION_SYNC_CLIENT_TIMEOUT_MS = 30_000;
export const LOCATION_SYNC_COMMAND_MAX_AGE_MS = 30_000;
export const LOCATION_SYNC_COMMAND_FUTURE_SKEW_MS = 5_000;
export const LOCATION_SYNC_REQUEST_BYTES = 512 * 1024;
export const LOCATION_SYNC_RESPONSE_BYTES = 1024 * 1024;
export const LOCATION_SYNC_MAX_RECORDS = 1024;
export const LOCATION_SYNC_COMMAND_ENV = {
  mode: 'CURRENT_STORE_LOCATION_SYNC_MODE',
  origin: 'CURRENT_STORE_LOCATION_SYNC_ORIGIN',
  secret: 'CURRENT_STORE_LOCATION_SYNC_RPC_SECRET',
} as const;

// JSON cannot represent these coordinates. Preserve the planner's original skip
// behavior instead of silently turning NaN/Infinity into null or zero.
const coordinate = z.union([z.number(), z.enum(['NaN', 'Infinity', '-Infinity'])]);
const text = z.string().max(4096);
export const locationSyncProviderSchema = z.enum([
  'tension',
  'decoy',
  'touchstone',
  'grasshopper',
  'soill',
  'moonboard',
]);
export const locationSyncRecordSchema = z
  .object({
    boardType: locationSyncProviderSchema,
    layoutId: z.number().int().safe(),
    sizeId: z.number().int().safe(),
    setIds: text,
    angle: z.number().finite(),
    isAngleAdjustable: z.boolean(),
    sourceKey: text.min(1),
    gymSourceKey: text.min(1),
    name: text,
    slugBase: text,
    locationName: text.nullable(),
    latitude: coordinate,
    longitude: coordinate,
    gymName: text,
    gymAddress: text.nullable(),
    serialNumber: text.nullable().optional(),
  })
  .strict();
const uuid = z.uuid().refine((contents) => contents === contents.toLowerCase());
const correlation = { protocolVersion: z.literal(1), operation: z.literal('apply'), requestId: uuid } as const;
export const locationSyncCommandSchema = z
  .object({
    ...correlation,
    issuedAt: z.number().int().nonnegative().safe(),
    payload: z
      .object({
        runId: uuid,
        attemptToken: uuid,
        records: z.array(locationSyncRecordSchema).min(1).max(LOCATION_SYNC_MAX_RECORDS),
      })
      .strict(),
  })
  .strict()
  .refine((command) => new Set(command.payload.records.map((record) => record.gymSourceKey)).size <= 25);
const count = z.number().int().nonnegative().safe();
export const locationSyncSummarySchema = z
  .object({
    boardsSeen: count,
    boardsUpserted: count,
    boardsSkipped: count,
    gymsSeen: count,
    gymsUpserted: count,
    skipped: z.array(z.object({ sourceKey: text, reason: text }).strict()).max(LOCATION_SYNC_MAX_RECORDS),
  })
  .strict();
export const locationSyncReplySchema = z.discriminatedUnion('outcome', [
  z.object({ ...correlation, outcome: z.literal('applied'), summary: locationSyncSummarySchema }).strict(),
  z
    .object({
      ...correlation,
      outcome: z.literal('rejected'),
      code: z.enum(['request_expired', 'attempt_lost', 'replayed_request', 'unavailable']),
    })
    .strict(),
]);
export type LocationSyncCommand = z.infer<typeof locationSyncCommandSchema>;
export type LocationSyncReply = z.infer<typeof locationSyncReplySchema>;
export type LocationSyncWireRecord = z.infer<typeof locationSyncRecordSchema>;
export function locationSyncReplyStatus(reply: LocationSyncReply): number {
  if (reply.outcome === 'applied') return 200;
  if (reply.code === 'request_expired') return 400;
  if (reply.code === 'attempt_lost' || reply.code === 'replayed_request') return 409;
  return 503;
}
export function currentStoreLocationSyncMode(
  environment: Readonly<Record<string, string | undefined>>,
): 'legacy' | 'backend-staging' {
  const mode = environment[LOCATION_SYNC_COMMAND_ENV.mode];
  if (mode === undefined || mode === '' || mode === 'legacy') return 'legacy';
  if (mode !== 'backend-staging') throw new Error('Invalid location-sync authority mode');
  return mode;
}
