import { z } from 'zod';
import { webCredentialProofSchema, WEB_CREDENTIAL_PROOF_VERSION } from './web-credential-proof';
import { issuedWebSessionSchema, presentedWebSessionSchema } from './web-session';

/** Identity protocol. It issues a first-party web session only when `resolve` asks for one (#7596 B5a). */
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

export const webOAuthProviderSchema = z.enum(['google', 'apple']);
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
/**
 * The SHA-256 (hex) a Google sign-in's `flow` must equal for its ID token to
 * count as a fresh sign-in: `JSON.stringify([WEB_OAUTH_GOOGLE_NONCE_DOMAIN, nonce])`.
 * Binding the nonce into the intent's flow makes it single use with the intent.
 */
export const WEB_OAUTH_GOOGLE_NONCE_DOMAIN = 'web-oauth-google-nonce-v1';

/**
 * Asks `resolve` to sign the browser in with a first-party web session
 * (#7596 B5a): issued for the resolved account in the same transaction,
 * revoking `presented`, the session the request arrived with. Needs
 * `CURRENT_STORE_WEB_SESSION_MODE=backend-staging` (404 without it) and
 * `actorCookie: null`: a sign-in never links a provider to the presented account.
 */
export const webOAuthSessionRequestSchema = z
  .object({
    presented: presentedWebSessionSchema.optional(),
    /**
     * Google only, optional: the raw ID token of this callback and its nonce.
     * The session counts as a fresh sign-in only when the backend verifies a
     * signed `auth_time` under five minutes old for this subject; otherwise,
     * and always for Apple, it is `carried`.
     */
    googleAuthentication: z
      .object({ idToken: z.string().min(1).max(16_384), nonce: z.string().min(1).max(1024) })
      .strict()
      .optional(),
  })
  .strict();

export const webOAuthResolveCommandSchema = z
  .object({
    ...metadata,
    operation: z.literal('resolve'),
    credentialProofVersion: z.literal(WEB_CREDENTIAL_PROOF_VERSION).optional(),
    webSession: webOAuthSessionRequestSchema.optional(),
    issuedAt: timestamp,
    payload: z.object({ ...intentPayload, subject, email: email.nullable(), name, image }).strict(),
  })
  .strict();
export const webOAuthCommandSchema = z.union([webOAuthIntentCommandSchema, webOAuthResolveCommandSchema]);

const GENERIC_DENIAL_CODES = ['identity_unavailable', 'replayed'] as const;
/**
 * Only `resolve` sees a provider profile, so only it can name these outcomes.
 * `link_required` (#7596 B5e1, decision D1): a session sign-in presented a live
 * session and no account owns the provider identity. Nothing is created and the
 * presented session is kept; the climber connects the provider from Settings.
 */
const RESOLVE_DENIAL_CODES = [...GENERIC_DENIAL_CODES, 'email_conflict', 'email_required', 'link_required'] as const;

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
      credentialProof: webCredentialProofSchema.optional(),
      /** Only when the command asked for one. `token` is the only copy. */
      webSession: issuedWebSessionSchema.optional(),
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
export type WebOAuthSessionRequest = z.infer<typeof webOAuthSessionRequestSchema>;
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
