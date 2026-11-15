import { z } from 'zod';
import { browserBindingCursorSchema, browserCoordinatorResultSchema } from './browser-coordinator-v1';

/** Explicit sign-in control metadata only. Tokens and preparations stay in the
 * canonical server's purpose-encrypted, HttpOnly operation carrier. */
export const EXPIRED_BROWSER_BINDING_BROWSER_PATHS = Object.freeze({
  prepare: '/api/internal/auth/browser-coordinator/signin/prepare',
  commit: '/api/internal/auth/browser-coordinator/signin/commit',
  confirm: '/api/internal/auth/browser-coordinator/signin/confirm',
});

export const expiredBrowserBindingBrowserPrepareSchema = z.object({}).strict();
const control = {
  operationKey: z.string().regex(/^[a-f0-9]{64}$/),
  sourceCursor: browserBindingCursorSchema,
  targetCursor: browserBindingCursorSchema.extend({ version: z.literal(0) }),
};
export const expiredBrowserBindingBrowserControlSchema = z
  .object(control)
  .strict()
  .refine((command) => command.sourceCursor.bindingId !== command.targetCursor.bindingId, {
    message: 'Expired binding target must be distinct',
  });

export const expiredBrowserBindingBrowserPreparationReplySchema = z.union([
  z
    .object({ status: z.literal('prepared'), ...control })
    .strict()
    .refine((reply) => reply.sourceCursor.bindingId !== reply.targetCursor.bindingId, {
      message: 'Expired binding target must be distinct',
    }),
  browserCoordinatorResultSchema,
]);
export type ExpiredBrowserBindingBrowserPreparationReply = z.infer<
  typeof expiredBrowserBindingBrowserPreparationReplySchema
>;
