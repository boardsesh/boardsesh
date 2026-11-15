import { z } from 'zod';
import { browserBindingCursorSchema } from './browser-coordinator-v1';

/** Public control metadata only. Passwords are sent solely in the canonical
 * installed NextAuth form; candidate bytes and capabilities stay in custody. */
export const BROWSER_PASSWORD_BROWSER_PATHS = Object.freeze({
  prepare: '/api/internal/auth/browser-password/prepare',
  commit: '/api/internal/auth/browser-password/commit',
  confirm: '/api/internal/auth/browser-password/confirm',
  acknowledge: '/api/internal/auth/browser-password/acknowledge',
});
export const BROWSER_PASSWORD_BROWSER_FORM_FIELDS = Object.freeze({
  bindingId: 'browserPasswordBindingId',
  version: 'browserPasswordVersion',
});
const operationKey = z.string().regex(/^[a-f0-9]{64}$/);
const destination = z
  .url()
  .max(4_096)
  .refine((text) => {
    const address = new URL(text);
    return address.protocol === 'https:' && !address.username && !address.password && !address.hash;
  });
export const browserPasswordBrowserPrepareMetadataSchema = z.object({ cursor: browserBindingCursorSchema }).strict();
export const browserPasswordBrowserControlSchema = z
  .object({ operationKey, cursor: browserBindingCursorSchema })
  .strict();
export const browserPasswordBrowserRecoverySchema = z
  .object({ purpose: z.literal('password-signin-recovery') })
  .strict();

export const browserPasswordBrowserReplySchema = z.union([
  z
    .object({
      status: z.literal('prepared'),
      operationKey,
      sourceCursor: browserBindingCursorSchema,
      targetCursor: browserBindingCursorSchema,
    })
    .strict()
    .refine(
      (reply) =>
        reply.sourceCursor.bindingId === reply.targetCursor.bindingId &&
        reply.targetCursor.version === reply.sourceCursor.version + 1,
    ),
  z.object({ status: z.literal('committed'), operationKey, cursor: browserBindingCursorSchema }).strict(),
  z
    .object({ status: z.literal('confirmed'), operationKey, cursor: browserBindingCursorSchema, url: destination })
    .strict(),
  z.object({ status: z.literal('recovered'), operationKey, cursor: browserBindingCursorSchema }).strict(),
  z.object({ status: z.literal('none') }).strict(),
  z
    .object({
      status: z.literal('framework-result'),
      result: z.object({ url: destination, status: z.number().int().min(200).max(599) }).strict(),
    })
    .strict(),
  z.object({ status: z.enum(['unavailable', 'conflict', 'proof-required', 'denied', 'rate-limited']) }).strict(),
]);
export type BrowserPasswordBrowserReply = z.infer<typeof browserPasswordBrowserReplySchema>;
