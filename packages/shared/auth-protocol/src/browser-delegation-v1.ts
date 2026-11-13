import { z } from 'zod';
import { browserBindingCursorSchema, browserSelectionPossessionSchema } from './browser-binding-v1';

/** Private service command. Public adapters return only this limited bearer,
 * never source proof bytes, binding tokens or the backend-only issuer key. */
export const BROWSER_DELEGATION_PROTOCOL_VERSION = 1;
export const BROWSER_DELEGATION_COMMAND_PATH = '/api/internal/auth/browser-delegation/v1/issue';
export const BROWSER_DELEGATION_REQUEST_BYTES = 65_536;
export const BROWSER_DELEGATION_RESPONSE_BYTES = 8192;
export const browserDelegationCommandSchema = z
  .object({
    browserDelegationProtocolVersion: z.literal(BROWSER_DELEGATION_PROTOCOL_VERSION),
    operation: z.literal('delegate'),
    requestId: z.uuidv4(),
    issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    payload: z
      .object({ bindingToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/), actor: browserSelectionPossessionSchema })
      .strict(),
  })
  .strict();
const metadata = {
  browserDelegationProtocolVersion: z.literal(BROWSER_DELEGATION_PROTOCOL_VERSION),
  operation: z.literal('delegate'),
  requestId: z.uuidv4(),
};
export const browserDelegationReplySchema = z.discriminatedUnion('outcome', [
  z
    .object({
      ...metadata,
      outcome: z.literal('admitted'),
      token: z
        .string()
        .min(1)
        .max(4096)
        .regex(/^bsbd1_[A-Za-z0-9_-]+$/),
      issuedAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
      cursor: browserBindingCursorSchema,
      userId: z.string().min(1).max(1024),
      authSessionId: z.string().min(1).max(1024),
    })
    .strict(),
  z.object({ ...metadata, outcome: z.enum(['denied', 'conflict', 'unavailable']) }).strict(),
]);
export type BrowserDelegationCommand = z.infer<typeof browserDelegationCommandSchema>;
export type BrowserDelegationReply = z.infer<typeof browserDelegationReplySchema>;
export function browserDelegationReplyStatus(reply: BrowserDelegationReply): number {
  return { admitted: 200, denied: 401, conflict: 409, unavailable: 503 }[reply.outcome];
}
