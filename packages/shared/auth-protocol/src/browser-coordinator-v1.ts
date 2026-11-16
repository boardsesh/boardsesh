import { z } from 'zod';

/** Control metadata only. No message is an authentication or identity assertion. */
export const BROWSER_COORDINATOR_PROTOCOL_VERSION = 1;
export const BROWSER_COORDINATOR_LOCK = 'boardsesh-browser-coordinator-v1';
export const BROWSER_COORDINATOR_FRAME_PATH = '/auth/browser-coordinator';
export const BROWSER_COORDINATOR_PUBLIC_PATHS = Object.freeze({
  observe: '/api/internal/auth/browser-coordinator/observe',
  initialize: '/api/internal/auth/browser-coordinator/initialize',
});
const identifier = z.uuid();
const version = z.number().int().min(0).max(2_147_483_647);
export const browserBindingCursorSchema = z.object({ bindingId: z.string().regex(/^[a-f0-9]{64}$/), version }).strict();
export type BrowserBindingCursor = z.infer<typeof browserBindingCursorSchema>;
export const browserCoordinatorCommandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('read') }).strict(),
  z
    .object({
      operation: z.literal('prepare'),
      transition: z.enum(['login', 'replacement', 'logout']),
      expectedCursor: browserBindingCursorSchema,
    })
    .strict(),
  z.object({ operation: z.literal('renew'), expectedCursor: browserBindingCursorSchema }).strict(),
]);
export type BrowserCoordinatorCommand = z.infer<typeof browserCoordinatorCommandSchema>;
export const browserCoordinatorResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), cursor: browserBindingCursorSchema }).strict(),
  ...(['conflict', 'proof-required', 'unavailable'] as const).map((status) =>
    z.object({ status: z.literal(status) }).strict(),
  ),
]);
export type BrowserCoordinatorResult = z.infer<typeof browserCoordinatorResultSchema>;
export const browserCoordinatorObservationSchema = z.union([
  browserCoordinatorResultSchema,
  z.object({ status: z.literal('missing-binding') }).strict(),
]);
const envelope = { protocolVersion: z.literal(BROWSER_COORDINATOR_PROTOCOL_VERSION), connectionId: identifier };
export const browserCoordinatorConnectSchema = z.object({ ...envelope, type: z.literal('connect') }).strict();
export const browserCoordinatorConnectedSchema = z.object({ ...envelope, type: z.literal('connected') }).strict();
export const browserCoordinatorRequestSchema = z
  .object({
    ...envelope,
    type: z.literal('request'),
    requestId: identifier,
    command: browserCoordinatorCommandSchema,
  })
  .strict();
export const browserCoordinatorCancelSchema = z
  .object({
    ...envelope,
    type: z.literal('cancel'),
    requestId: identifier,
  })
  .strict();
export const browserCoordinatorReplySchema = z
  .object({
    ...envelope,
    type: z.literal('result'),
    requestId: identifier,
    operation: z.enum(['read', 'prepare', 'renew']),
    result: browserCoordinatorResultSchema,
  })
  .strict();

/** Exact HTTPS origin, never a URL with credentials/path/query or an inferred sibling. */
export function requireCoordinatorOrigin(input: string): string {
  const address = new URL(input);
  if (address.protocol !== 'https:' || address.origin !== input) throw new Error('COORDINATOR_ORIGIN_INVALID');
  return input;
}

/** A new binding requires a separate confirmed bootstrap, not a stale reply. */
export function compareBrowserBindingCursor(
  current: BrowserBindingCursor | null,
  incoming: BrowserBindingCursor,
): 'current' | 'stale' | 'different-binding' {
  if (!current) return 'current';
  if (current.bindingId !== incoming.bindingId) return 'different-binding';
  return incoming.version < current.version ? 'stale' : 'current';
}
