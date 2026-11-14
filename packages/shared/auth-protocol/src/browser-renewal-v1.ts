import { z } from 'zod';
import {
  browserSelectionPossessionSchema,
  browserSourceCredentialSchema,
  browserBindingCursorSchema,
} from './browser-binding-v1';
import { webCredentialProofSchema } from './web-credential-proof';

/** Private backend protocol. Public adapters project control metadata only. */
export const BROWSER_RENEWAL_PROTOCOL_VERSION = 1;
export const BROWSER_RENEWAL_MODE_ENV = 'CURRENT_STORE_BROWSER_RENEWAL_MODE';
export const BROWSER_RENEWAL_PATH_PREFIX = '/api/internal/auth/browser-renewal/v1';
export const BROWSER_RENEWAL_COMMAND_PATHS = Object.freeze({
  prepare: `${BROWSER_RENEWAL_PATH_PREFIX}/prepare`,
  finalize: `${BROWSER_RENEWAL_PATH_PREFIX}/finalize`,
  acknowledge: `${BROWSER_RENEWAL_PATH_PREFIX}/acknowledge`,
});
export const BROWSER_RENEWAL_REQUEST_BYTES = 65_536;
export const BROWSER_RENEWAL_RESPONSE_BYTES = 65_536;
export function browserRenewalMode(
  environment: Readonly<Record<string, string | undefined>> = {},
): 'legacy' | 'backend-staging' {
  const selected = environment[BROWSER_RENEWAL_MODE_ENV];
  if (selected === undefined || selected === '' || selected === 'legacy') return 'legacy';
  if (selected === 'backend-staging') return selected;
  throw new Error('BROWSER_RENEWAL_MODE_INVALID');
}
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().min(0).max(2_147_483_647);
export const browserRenewalPreparationSchema = z
  .object({
    version: z.literal(1),
    credentialKind: z.enum(['legacy-jwe', 'canonical-token']),
    sourceCredentialProof: webCredentialProofSchema,
    sourceCredentialHash: digest,
    sourceExpiresAt: z.iso.datetime(),
    browserCursor: browserBindingCursorSchema,
    intentRevision: version,
    futureBrowserCursor: browserBindingCursorSchema,
    targetExpiresAt: z.iso.datetime(),
    preparedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((preparation, context) => {
    const preparedAt = Date.parse(preparation.preparedAt);
    const target = Date.parse(preparation.targetExpiresAt);
    const expiresAt = Date.parse(preparation.expiresAt);
    const sourceDeadline = Date.parse(preparation.sourceExpiresAt);
    const bindingDeadline = Date.parse(preparation.browserCursor.bindingExpiresAt);
    const futureBindingDeadline = Date.parse(preparation.futureBrowserCursor.bindingExpiresAt);
    if (
      preparation.futureBrowserCursor.bindingId !== preparation.browserCursor.bindingId ||
      preparation.futureBrowserCursor.version !== preparation.browserCursor.version + 1 ||
      target !== (Math.floor(preparedAt / 1_000) + 30 * 24 * 60 * 60) * 1_000 ||
      sourceDeadline <= preparedAt ||
      target < sourceDeadline ||
      bindingDeadline <= preparedAt ||
      expiresAt <= preparedAt ||
      expiresAt > Math.min(preparedAt + 60_000, sourceDeadline, bindingDeadline) ||
      futureBindingDeadline < Math.max(target, bindingDeadline) ||
      preparation.sourceCredentialProof.linkGuarded !== (preparation.sourceCredentialProof.authenticatedAt !== null)
    )
      context.addIssue({ code: 'custom', message: 'Invalid renewal evidence' });
  });
export type BrowserRenewalPreparation = z.infer<typeof browserRenewalPreparationSchema>;
const actor = { bindingToken: opaque, actor: browserSelectionPossessionSchema };
const bound = {
  ...actor,
  operationToken: opaque,
  preparationToken: opaque,
  nonceHash: digest,
  preparation: browserRenewalPreparationSchema,
};
const metadata = {
  browserRenewalProtocolVersion: z.literal(1),
  requestId: z.uuidv4(),
  issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
export const browserRenewalCommandSchema = z.discriminatedUnion('operation', [
  z
    .object({
      ...metadata,
      operation: z.literal('prepare'),
      payload: z.object({ ...actor, nonceHash: digest }).strict(),
    })
    .strict(),
  z
    .object({
      ...metadata,
      operation: z.literal('finalize'),
      payload: z.object({ ...bound, candidate: browserSourceCredentialSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...metadata,
      operation: z.literal('acknowledge'),
      payload: z.object({ ...bound, candidate: browserSourceCredentialSchema }).strict(),
    })
    .strict(),
]);
export type BrowserRenewalCommand = z.infer<typeof browserRenewalCommandSchema>;
const reply = { browserRenewalProtocolVersion: z.literal(1), requestId: z.uuidv4() };
export const browserRenewalReplySchema = z.union([
  z
    .object({
      ...reply,
      operation: z.literal('prepare'),
      outcome: z.literal('prepared'),
      operationToken: opaque,
      preparationToken: opaque,
      preparation: browserRenewalPreparationSchema,
    })
    .strict(),
  z
    .object({
      ...reply,
      operation: z.enum(['finalize', 'acknowledge']),
      outcome: z.literal('completed'),
      cursor: browserBindingCursorSchema,
      credentialProof: webCredentialProofSchema,
      credentialExpiresAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      ...reply,
      operation: z.enum(['prepare', 'finalize', 'acknowledge']),
      outcome: z.enum(['conflict', 'denied', 'unavailable']),
    })
    .strict(),
]);
export type BrowserRenewalReply = z.infer<typeof browserRenewalReplySchema>;
export function browserRenewalReplyStatus(reply: BrowserRenewalReply): 200 | 401 | 409 | 503 {
  if (reply.outcome === 'denied') return 401;
  if (reply.outcome === 'conflict') return 409;
  if (reply.outcome === 'unavailable') return 503;
  return 200;
}
