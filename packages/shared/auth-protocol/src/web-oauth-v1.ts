import { z } from 'zod';

/** Independent identity-only protocol; it never issues a continuing credential. */
export const WEB_OAUTH_PROTOCOL_VERSION = 1;
export const WEB_OAUTH_PATH_PREFIX = '/api/internal/auth/current-store/web-oauth/v1';
export const WEB_OAUTH_COMMAND_PATHS = {
  intent: `${WEB_OAUTH_PATH_PREFIX}/intent`,
  resolve: `${WEB_OAUTH_PATH_PREFIX}/resolve`,
} as const;
/** Logical field limits; the transport's independent byte cap may reject sooner. */
export const WEB_OAUTH_FIELD_LIMITS = {
  subject: 1024,
  actorCookie: 65_536,
  email: 8192,
  name: 8192,
  image: 8192,
  userId: 1024,
} as const;

export const webOAuthProviderSchema = z.enum(['google', 'apple', 'facebook']);
const version = z.literal(WEB_OAUTH_PROTOCOL_VERSION);
const requestId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const timestamp = z.iso.datetime();
const flow = z.string().regex(/^[0-9a-f]{64}$/);
const subject = z.string().min(1).max(WEB_OAUTH_FIELD_LIMITS.subject);
const actorCookie = z.string().min(1).max(WEB_OAUTH_FIELD_LIMITS.actorCookie).nullable();
const email = z.string().min(1).max(WEB_OAUTH_FIELD_LIMITS.email);
const name = z.string().max(WEB_OAUTH_FIELD_LIMITS.name).nullable();
const image = z.string().max(WEB_OAUTH_FIELD_LIMITS.image).nullable();
const metadata = { webOAuthProtocolVersion: version, requestId };
const intentPayload = { provider: webOAuthProviderSchema, flow, actorCookie };

export const webOAuthIntentCommandSchema = z
  .object({
    ...metadata,
    operation: z.literal('intent'),
    issuedAt: timestamp,
    payload: z.object(intentPayload).strict(),
  })
  .strict();
export const webOAuthResolveCommandSchema = z
  .object({
    ...metadata,
    operation: z.literal('resolve'),
    issuedAt: timestamp,
    payload: z.object({ ...intentPayload, subject, email: email.nullable(), name, image }).strict(),
  })
  .strict();
export const webOAuthCommandSchema = z.union([webOAuthIntentCommandSchema, webOAuthResolveCommandSchema]);

const GENERIC_DENIAL_CODES = ['identity_unavailable', 'replayed'] as const;
/** Only `resolve` sees a provider profile, so only it can name these two outcomes. */
const RESOLVE_DENIAL_CODES = [...GENERIC_DENIAL_CODES, 'email_conflict', 'email_required'] as const;

function deniedReply<
  Operation extends keyof typeof WEB_OAUTH_COMMAND_PATHS,
  const Codes extends readonly [string, ...string[]],
>(operation: Operation, codes: Codes) {
  return z
    .object({
      ...metadata,
      operation: z.literal(operation),
      outcome: z.literal('denied'),
      code: z.enum(codes),
    })
    .strict();
}

/** Private response: the public adapter must project its own response. */
export const webOAuthUserSchema = z
  .object({
    id: z.string().min(1).max(WEB_OAUTH_FIELD_LIMITS.userId),
    email,
    name,
    image,
    emailVerified: timestamp.nullable(),
    createdAt: timestamp,
  })
  .strict();
export const webOAuthAccountSchema = z
  .object({ provider: webOAuthProviderSchema, providerAccountId: subject })
  .strict();
export const webOAuthIntentReplySchema = z.union([
  z
    .object({ ...metadata, operation: z.literal('intent'), outcome: z.literal('recorded'), flow, expiresAt: timestamp })
    .strict(),
  deniedReply('intent', GENERIC_DENIAL_CODES),
]);
export const webOAuthResolveReplySchema = z.union([
  z
    .object({
      ...metadata,
      operation: z.literal('resolve'),
      outcome: z.literal('resolved'),
      user: webOAuthUserSchema,
      createdUser: z.boolean(),
      account: webOAuthAccountSchema,
    })
    .strict(),
  deniedReply('resolve', RESOLVE_DENIAL_CODES),
]);
export const webOAuthReplySchema = z.union([webOAuthIntentReplySchema, webOAuthResolveReplySchema]);

/** Transport/configuration uncertainty is separate from an authoritative denial. */
export const webOAuthProtocolRejectionSchema = z
  .object({ error: z.enum(['invalid_request', 'expired_request', 'unauthorized', 'disabled', 'unavailable']) })
  .strict();

export type WebOAuthProvider = z.infer<typeof webOAuthProviderSchema>;
export type WebOAuthIntentCommand = z.infer<typeof webOAuthIntentCommandSchema>;
export type WebOAuthResolveCommand = z.infer<typeof webOAuthResolveCommandSchema>;
export type WebOAuthCommand = z.infer<typeof webOAuthCommandSchema>;
export type WebOAuthUser = z.infer<typeof webOAuthUserSchema>;
export type WebOAuthAccount = z.infer<typeof webOAuthAccountSchema>;
export type WebOAuthIntentReply = z.infer<typeof webOAuthIntentReplySchema>;
export type WebOAuthResolveReply = z.infer<typeof webOAuthResolveReplySchema>;
export type WebOAuthResolveDenialCode = Extract<WebOAuthResolveReply, { outcome: 'denied' }>['code'];
export type WebOAuthReply = z.infer<typeof webOAuthReplySchema>;
export type WebOAuthProtocolRejection = z.infer<typeof webOAuthProtocolRejectionSchema>;

export function webOAuthReplyStatus(reply: WebOAuthReply): 200 | 409 {
  return reply.outcome === 'denied' ? 409 : 200;
}
export function webOAuthProtocolRejectionStatus(reply: WebOAuthProtocolRejection): 400 | 401 | 404 | 503 {
  if (reply.error === 'unauthorized') return 401;
  if (reply.error === 'disabled') return 404;
  if (reply.error === 'unavailable') return 503;
  return 400;
}
