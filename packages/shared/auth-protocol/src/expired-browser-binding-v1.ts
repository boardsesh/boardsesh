import { z } from 'zod';
import { browserBindingCursorSchema } from './browser-binding-v1';

/** Service-only, explicit-action prerequisite. This never admits an expired
 * credential and cannot replace the proof of a live selected binding. */
export const EXPIRED_BROWSER_BINDING_PROTOCOL_VERSION = 1;
export const EXPIRED_BROWSER_BINDING_MODE_ENV = 'CURRENT_STORE_EXPIRED_BROWSER_BINDING_MODE';
export const EXPIRED_BROWSER_BINDING_PATH_PREFIX = '/api/internal/auth/expired-browser-binding/v1';
export const EXPIRED_BROWSER_BINDING_COMMAND_PATHS = Object.freeze({
  prepare: `${EXPIRED_BROWSER_BINDING_PATH_PREFIX}/prepare`,
  finalize: `${EXPIRED_BROWSER_BINDING_PATH_PREFIX}/finalize`,
  acknowledge: `${EXPIRED_BROWSER_BINDING_PATH_PREFIX}/acknowledge`,
});
export const EXPIRED_BROWSER_BINDING_REQUEST_BYTES = 16_384;
export const EXPIRED_BROWSER_BINDING_RESPONSE_BYTES = 16_384;
export const EXPIRED_BROWSER_BINDING_PREPARATION_MS = 60_000;
export const EXPIRED_BROWSER_BINDING_ACK_MS = 300_000;
export const EXPIRED_BROWSER_BINDING_TARGET_MS = 30 * 24 * 60 * 60 * 1_000;
export function expiredBrowserBindingMode(environment: Readonly<Record<string, string | undefined>> = {}) {
  const mode = environment[EXPIRED_BROWSER_BINDING_MODE_ENV];
  if (mode === undefined || mode === '' || mode === 'legacy') return 'legacy' as const;
  if (mode === 'backend-staging') return mode;
  throw new Error('EXPIRED_BROWSER_BINDING_MODE_INVALID');
}
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().min(0).max(2_147_483_647);
export const expiredBrowserBindingPreparationSchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal('expired-browser-binding-retirement-v1'),
    oldBindingId: digest,
    oldVersion: version,
    oldIntentRevision: version,
    oldStateHash: digest,
    oldExpiresAt: z.iso.datetime(),
    targetCursor: browserBindingCursorSchema,
    nonceHash: digest,
    authority: z
      .object({
        projectionId: z.string().min(1).max(1_024),
        normalizerVersion: z.string().min(1).max(128),
        authority: z.enum(['current-store', 'better-auth']),
        epoch: z.number().int().min(1).max(2_147_483_647),
      })
      .strict(),
    preparedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    acknowledgeUntil: z.iso.datetime(),
  })
  .strict()
  .superRefine((preparation, context) => {
    const preparedAt = Date.parse(preparation.preparedAt);
    const expiresAt = Date.parse(preparation.expiresAt);
    if (
      Date.parse(preparation.oldExpiresAt) > preparedAt ||
      expiresAt <= preparedAt ||
      expiresAt > preparedAt + EXPIRED_BROWSER_BINDING_PREPARATION_MS ||
      Date.parse(preparation.acknowledgeUntil) !== preparedAt + EXPIRED_BROWSER_BINDING_ACK_MS ||
      preparation.targetCursor.version !== 0 ||
      preparation.targetCursor.bindingId === preparation.oldBindingId ||
      Date.parse(preparation.targetCursor.bindingExpiresAt) !== preparedAt + EXPIRED_BROWSER_BINDING_TARGET_MS
    )
      context.addIssue({ code: 'custom', message: 'Invalid expired binding preparation' });
  });
export type ExpiredBrowserBindingPreparation = z.infer<typeof expiredBrowserBindingPreparationSchema>;
const metadata = {
  expiredBrowserBindingProtocolVersion: z.literal(1),
  requestId: z.uuidv4(),
  issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
const bound = {
  bindingToken: opaque,
  targetBindingToken: opaque,
  operationToken: opaque,
  preparation: expiredBrowserBindingPreparationSchema,
};
export const expiredBrowserBindingCommandSchema = z.discriminatedUnion('operation', [
  z
    .object({
      ...metadata,
      operation: z.literal('prepare'),
      payload: z.object({ bindingToken: opaque, expectedVersion: version.optional(), nonceHash: digest }).strict(),
    })
    .strict(),
  z.object({ ...metadata, operation: z.literal('finalize'), payload: z.object(bound).strict() }).strict(),
  z.object({ ...metadata, operation: z.literal('acknowledge'), payload: z.object(bound).strict() }).strict(),
]);
export type ExpiredBrowserBindingCommand = z.infer<typeof expiredBrowserBindingCommandSchema>;
const reply = { expiredBrowserBindingProtocolVersion: z.literal(1), requestId: z.uuidv4() };
export const expiredBrowserBindingReplySchema = z.union([
  z
    .object({
      ...reply,
      operation: z.literal('prepare'),
      outcome: z.literal('prepared'),
      operationToken: opaque,
      targetBindingToken: opaque,
      preparation: expiredBrowserBindingPreparationSchema,
    })
    .strict(),
  z
    .object({
      ...reply,
      operation: z.enum(['finalize', 'acknowledge']),
      outcome: z.literal('completed'),
      cursor: browserBindingCursorSchema,
    })
    .strict(),
  z
    .object({
      ...reply,
      operation: z.enum(['prepare', 'finalize', 'acknowledge']),
      outcome: z.enum(['denied', 'conflict', 'unavailable']),
    })
    .strict(),
]);
export type ExpiredBrowserBindingReply = z.infer<typeof expiredBrowserBindingReplySchema>;
export function expiredBrowserBindingReplyStatus(reply: ExpiredBrowserBindingReply): 200 | 401 | 409 | 503 {
  if (reply.outcome === 'denied') return 401;
  if (reply.outcome === 'conflict') return 409;
  if (reply.outcome === 'unavailable') return 503;
  return 200;
}
