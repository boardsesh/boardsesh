import { z } from 'zod';
import { browserBindingCursorSchema, browserSelectionPossessionSchema } from './browser-binding-v1';

/** Private service command. Public adapters return only this single-use native handoff,
 * never source proof bytes, binding tokens or the backend-only handoff key. */
export const NATIVE_BROWSER_HANDOFF_PROTOCOL_VERSION = 1;
export const NATIVE_BROWSER_HANDOFF_COMMAND_PATH = '/api/internal/auth/native-browser-handoff/v1/issue';
export const NATIVE_BROWSER_HANDOFF_REQUEST_BYTES = 65_536;
export const NATIVE_BROWSER_HANDOFF_RESPONSE_BYTES = 8192;
export const nativeBrowserHandoffCommandSchema = z
  .object({
    nativeBrowserHandoffProtocolVersion: z.literal(NATIVE_BROWSER_HANDOFF_PROTOCOL_VERSION),
    operation: z.literal('issue'),
    requestId: z.uuidv4(),
    issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    payload: z
      .object({ bindingToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/), actor: browserSelectionPossessionSchema })
      .strict(),
  })
  .strict();
const metadata = {
  nativeBrowserHandoffProtocolVersion: z.literal(NATIVE_BROWSER_HANDOFF_PROTOCOL_VERSION),
  operation: z.literal('issue'),
  requestId: z.uuidv4(),
};
export const nativeBrowserHandoffReplySchema = z.discriminatedUnion('outcome', [
  z
    .object({
      ...metadata,
      outcome: z.literal('admitted'),
      token: z
        .string()
        .min(1)
        .max(4000)
        .regex(/^bsnh1_[A-Za-z0-9_-]+$/),
      issuedAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
      cursor: browserBindingCursorSchema,
      userId: z.string().min(1).max(1024),
      authSessionId: z.string().min(1).max(1024),
    })
    .strict(),
  z.object({ ...metadata, outcome: z.enum(['denied', 'conflict', 'unavailable']) }).strict(),
]);
export type NativeBrowserHandoffCommand = z.infer<typeof nativeBrowserHandoffCommandSchema>;
export type NativeBrowserHandoffReply = z.infer<typeof nativeBrowserHandoffReplySchema>;
export function nativeBrowserHandoffReplyStatus(reply: NativeBrowserHandoffReply): number {
  return { admitted: 200, denied: 401, conflict: 409, unavailable: 503 }[reply.outcome];
}
