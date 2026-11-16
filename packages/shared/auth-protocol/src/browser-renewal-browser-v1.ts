import { z } from 'zod';
import { browserBindingCursorSchema } from './browser-coordinator-v1';

/** Browser-visible control only. Credentials and private operation capabilities
 * stay in the canonical host's HttpOnly cookies and service transport.
 * #7596 deleted the www routes below with renewal custody; they now answer 404.
 * Two dark callers still name them, both behind hard-false gates: the frame's
 * `renew` transport (browser-coordinator-dom/runner/channel, mounted only by the
 * www /auth/browser-coordinator page) and the Expo web
 * `coordinateExpoBrowserSession`. A4 removes the Expo web caller; the
 * coordinator deletion removes the frame and this module. */
export const BROWSER_RENEWAL_BROWSER_PATHS = Object.freeze({
  prepare: '/api/internal/auth/browser-coordinator/renew/prepare',
  commit: '/api/internal/auth/browser-coordinator/renew/commit',
});
const operationKey = z.string().regex(/^[a-f0-9]{64}$/);
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
