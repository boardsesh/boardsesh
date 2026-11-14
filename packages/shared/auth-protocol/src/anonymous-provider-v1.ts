import { z } from 'zod';
import { webCredentialProofSchema } from './web-credential-proof';

/** Source-free provider login has a distinct protocol. A missing/refused
 * signed-in actor can never be coerced into this positive anonymous context. */
export const ANONYMOUS_PROVIDER_VERSION = 1;
export const ANONYMOUS_PROVIDER_PREFIX = '/api/internal/auth/anonymous-provider/v1';
export const ANONYMOUS_PROVIDER_REQUEST_BYTES = 196_608;
export const ANONYMOUS_PROVIDER_RESPONSE_BYTES = 131_072;
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(1024);
const timestamp = z.iso.datetime();
const provider = z.enum(['google', 'apple']);
const credentialKind = z.enum(['legacy-jwe', 'canonical-token']);
const candidate = z.object({ kind: credentialKind, credential: z.string().min(1).max(16_384) }).strict();
export const anonymousProviderBrowserSchema = z
  .object({
    bindingToken: token,
    expectedVersion: z.number().int().nonnegative().max(2_147_483_646),
  })
  .strict();
export const providerIdentityPlanSchema = z
  .object({
    kind: z.enum(['existing', 'new']),
    provider,
    subject: text,
    generation: z.number().int().nonnegative().max(2_147_483_647),
    user: z
      .object({
        id: text,
        email: z.string().min(1).max(8192),
        name: z.string().max(8192).nullable(),
        image: z.string().max(8192).nullable(),
        emailVerified: timestamp.nullable(),
        createdAt: timestamp,
      })
      .strict(),
  })
  .strict();
type ProviderIdentityPlanFields = z.infer<typeof providerIdentityPlanSchema>;
export type ProviderIdentityPlan = Readonly<Omit<ProviderIdentityPlanFields, 'user'>> & {
  readonly user: Readonly<ProviderIdentityPlanFields['user']>;
};
const verifiedIdentity = z
  .object({
    sub: text,
    email: z.string().max(8192).nullable(),
    emailVerified: z.boolean(),
    name: z.string().max(8192).nullable(),
    image: z.string().max(8192).nullable(),
  })
  .strict();
export const anonymousProviderPreparationSchema = z
  .object({
    credentialKind,
    nativeAttemptHash: digest.optional(),
    identityPlan: providerIdentityPlanSchema,
    verifiedIdentity,
    credentialProof: webCredentialProofSchema,
    credentialExpiresAt: timestamp,
    expiresAt: timestamp,
    proposedCanonicalTokenHash: digest.nullable(),
  })
  .strict();
export type AnonymousProviderPreparation = z.infer<typeof anonymousProviderPreparationSchema>;
const bound = {
  browser: anonymousProviderBrowserSchema,
  intentToken: token,
  browserIntentToken: token,
  flowHash: digest,
  nonceHash: digest.nullable(),
  nativeAttemptHash: digest.optional(),
};
const metadata = { anonymousProviderVersion: z.literal(1), requestId: z.uuidv4(), issuedAt: timestamp };
const command = <Operation extends string, Shape extends z.ZodRawShape>(operation: Operation, payload: Shape) =>
  z.object({ ...metadata, operation: z.literal(operation), payload: z.object(payload).strict() }).strict();
export const anonymousProviderPayloadSchemas = {
  intent: z
    .object({
      browser: anonymousProviderBrowserSchema,
      provider,
      flowHash: digest,
      nonceHash: digest.nullable(),
      nativeAttemptHash: digest.optional(),
      credentialKind,
    })
    .strict(),
  prepare: z
    .object({
      ...bound,
      credentialKind,
      providerProof: z
        .object({
          provider,
          identity: verifiedIdentity,
          idToken: z.string().min(1).max(16_384).nullable(),
          nonce: z.string().min(1).max(1024).nullable(),
        })
        .strict(),
    })
    .strict(),
  finalize: z
    .object({ ...bound, preparationToken: token, preparation: anonymousProviderPreparationSchema, candidate })
    .strict(),
  abort: z
    .object({
      ...bound,
      credentialKind,
      preparationToken: token.nullable(),
      preparation: anonymousProviderPreparationSchema.nullable(),
    })
    .strict(),
} as const;
export const anonymousProviderCommandSchema = z.discriminatedUnion('operation', [
  command('intent', anonymousProviderPayloadSchemas.intent.shape),
  command('prepare', anonymousProviderPayloadSchemas.prepare.shape),
  command('finalize', anonymousProviderPayloadSchemas.finalize.shape),
  command('abort', anonymousProviderPayloadSchemas.abort.shape),
]);
export type AnonymousProviderCommand = z.infer<typeof anonymousProviderCommandSchema>;
export type AnonymousProviderOperation = AnonymousProviderCommand['operation'];
export const ANONYMOUS_PROVIDER_PATHS = {
  intent: `${ANONYMOUS_PROVIDER_PREFIX}/intent`,
  prepare: `${ANONYMOUS_PROVIDER_PREFIX}/prepare`,
  finalize: `${ANONYMOUS_PROVIDER_PREFIX}/finalize`,
  abort: `${ANONYMOUS_PROVIDER_PREFIX}/abort`,
} as const satisfies Record<AnonymousProviderOperation, string>;
const replyMetadata = { anonymousProviderVersion: z.literal(1), requestId: z.uuidv4() };
const cursor = z
  .object({
    bindingId: digest,
    version: z.number().int().nonnegative().max(2_147_483_647),
    bindingExpiresAt: timestamp,
  })
  .strict();
export const anonymousProviderReplySchema = z.union([
  z
    .object({
      ...replyMetadata,
      operation: z.literal('intent'),
      outcome: z.literal('recorded'),
      intentToken: token,
      browserIntentToken: token,
      browserCursor: cursor,
      expiresAt: timestamp,
    })
    .strict(),
  z
    .object({
      ...replyMetadata,
      operation: z.literal('prepare'),
      outcome: z.literal('prepared'),
      preparationToken: token,
      preparation: anonymousProviderPreparationSchema,
      proposedCanonicalToken: token.nullable(),
      browserCursor: cursor,
    })
    .strict(),
  z
    .object({
      ...replyMetadata,
      operation: z.literal('finalize'),
      outcome: z.enum(['committed', 'recovered']),
      candidateCredentialHash: digest,
      browserCursor: cursor,
    })
    .strict(),
  z.object({ ...replyMetadata, operation: z.literal('abort'), outcome: z.literal('aborted') }).strict(),
  z
    .object({
      ...replyMetadata,
      operation: z.enum(['intent', 'prepare', 'finalize', 'abort']),
      outcome: z.enum(['denied', 'identity_changed', 'unavailable']),
      code: z.enum([
        'invalid_intent',
        'invalid_proof',
        'expired',
        'replayed',
        'provider_unavailable',
        'ownership_conflict',
        'authority_unavailable',
      ]),
    })
    .strict(),
]);
export type AnonymousProviderReply = z.infer<typeof anonymousProviderReplySchema>;

export function anonymousProviderReplyStatus(reply: AnonymousProviderReply): 200 | 400 | 403 | 409 | 503 {
  if (reply.outcome === 'unavailable') return 503;
  if (reply.outcome === 'identity_changed') return 409;
  if (reply.outcome === 'denied') return reply.code === 'invalid_intent' ? 400 : 403;
  return 200;
}
