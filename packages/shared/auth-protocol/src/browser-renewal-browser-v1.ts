import { z } from 'zod';
import { browserBindingCursorSchema } from './browser-coordinator-v1';

/** Browser-visible control only. Credentials and private operation capabilities
 * stay in the canonical host's HttpOnly cookies and service transport. */
export const BROWSER_RENEWAL_BROWSER_PATHS = Object.freeze({
  prepare: '/api/internal/auth/browser-coordinator/renew/prepare',
  commit: '/api/internal/auth/browser-coordinator/renew/commit',
});
const operationKey = z.string().regex(/^[a-f0-9]{64}$/);
export const browserRenewalBrowserPrepareSchema = z.object({ expectedCursor: browserBindingCursorSchema }).strict();
export const browserRenewalBrowserCommitSchema = browserRenewalBrowserPrepareSchema.extend({ operationKey }).strict();
const refusal = z.object({ status: z.enum(['conflict', 'proof-required', 'unavailable']) }).strict();
export const browserRenewalBrowserPreparationReplySchema = z.union([
  z.object({ status: z.literal('prepared'), operationKey, cursor: browserBindingCursorSchema }).strict(),
  z.object({ status: z.literal('anonymous'), cursor: browserBindingCursorSchema }).strict(),
  z.object({ status: z.literal('current'), cursor: browserBindingCursorSchema }).strict(),
  refusal,
]);
/** Internal canonical transport result. The runner checks the exact transition
 * before projecting its ordinary metadata-only ready reply to MessagePorts. */
export const browserRenewalBrowserResultSchema = z.union([
  z
    .object({
      status: z.literal('ready'),
      cursor: browserBindingCursorSchema,
      renewal: z.enum(['unchanged', 'renewed']),
    })
    .strict(),
  refusal,
]);
export type BrowserRenewalBrowserResult = z.infer<typeof browserRenewalBrowserResultSchema>;
