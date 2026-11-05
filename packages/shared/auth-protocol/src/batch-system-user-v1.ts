import { z } from 'zod';

export const BATCH_SYSTEM_USER_COMMAND_PATH = '/api/internal/auth/current-store/batch-system-users/v1/ensure';
export const BATCH_SYSTEM_USER_COMMAND_TIMEOUT_MS = 8_000;
export const BATCH_SYSTEM_USER_COMMAND_MAX_AGE_MS = 30_000;
export const BATCH_SYSTEM_USER_COMMAND_FUTURE_SKEW_MS = 5_000;
export const BATCH_SYSTEM_USER_COMMAND_ENV = {
  mode: 'CURRENT_STORE_BATCH_SYSTEM_USERS_MODE',
  origin: 'CURRENT_STORE_BATCH_SYSTEM_USERS_ORIGIN',
  secret: 'CURRENT_STORE_BATCH_SYSTEM_USERS_RPC_SECRET',
} as const;

const canonicalUuid = z.uuid().refine((contents) => contents === contents.toLowerCase());
const correlation = {
  protocolVersion: z.literal(1),
  operation: z.literal('ensure'),
  requestId: canonicalUuid,
} as const;

/** The backend derives the fixed identity from its locked persisted job family. */
export const batchSystemUserCommandSchema = z
  .object({
    ...correlation,
    issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    payload: z.object({ runId: canonicalUuid, attemptToken: canonicalUuid }).strict(),
  })
  .strict();

export const batchSystemUserRejectionCodeSchema = z.enum([
  'invalid_request',
  'unauthorized',
  'request_expired',
  'attempt_lost',
  'replayed_request',
  'unavailable',
]);

export const batchSystemUserReplySchema = z.discriminatedUnion('outcome', [
  z.object({ ...correlation, outcome: z.literal('ensured') }).strict(),
  z.object({ ...correlation, outcome: z.literal('rejected'), code: batchSystemUserRejectionCodeSchema }).strict(),
]);

export type BatchSystemUserCommand = z.infer<typeof batchSystemUserCommandSchema>;
export type BatchSystemUserReply = z.infer<typeof batchSystemUserReplySchema>;
export type BatchSystemUserRejectionCode = z.infer<typeof batchSystemUserRejectionCodeSchema>;

export function parseBatchSystemUserReply(reply: unknown): BatchSystemUserReply {
  return batchSystemUserReplySchema.parse(reply);
}

export function batchSystemUserReplyStatus(reply: BatchSystemUserReply): number {
  if (reply.outcome === 'ensured') return 200;
  if (reply.code === 'unauthorized') return 401;
  if (reply.code === 'invalid_request' || reply.code === 'request_expired') return 400;
  if (reply.code === 'attempt_lost' || reply.code === 'replayed_request') return 409;
  return 503;
}

/** Pure selection; each platform supplies its own captured environment. */
export function currentStoreBatchSystemUsersMode(
  environment: Readonly<Record<string, string | undefined>>,
): 'legacy' | 'backend-staging' {
  const mode = environment[BATCH_SYSTEM_USER_COMMAND_ENV.mode];
  if (mode === undefined || mode === '' || mode === 'legacy') return 'legacy';
  if (mode !== 'backend-staging') throw new Error('Invalid batch system-user authority mode');
  return mode;
}
