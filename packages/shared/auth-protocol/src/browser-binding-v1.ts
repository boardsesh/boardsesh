import { z } from 'zod';

/** Private service protocol. A public adapter must project its own response. */
export const BROWSER_BINDING_PROTOCOL_VERSION = 1;
export const BROWSER_BINDING_PATH_PREFIX = '/api/internal/auth/browser-binding/v1';
export const BROWSER_BINDING_MODE_ENV = 'CURRENT_STORE_BROWSER_BINDING_MODE';
export const BROWSER_BINDING_REQUEST_BYTES = 65_536;
export const BROWSER_BINDING_RESPONSE_BYTES = 65_536;
export const BROWSER_BINDING_SOURCE_BYTES = 16_384;
export const BROWSER_BINDING_COMMAND_PATHS = {
  bootstrap: `${BROWSER_BINDING_PATH_PREFIX}/bootstrap`,
  describe: `${BROWSER_BINDING_PATH_PREFIX}/describe`,
  read: `${BROWSER_BINDING_PATH_PREFIX}/read`,
  intent: `${BROWSER_BINDING_PATH_PREFIX}/intent`,
  login: `${BROWSER_BINDING_PATH_PREFIX}/login`,
  logout: `${BROWSER_BINDING_PATH_PREFIX}/logout`,
} as const;

export function browserBindingMode(
  environment: Readonly<Record<string, string | undefined>> = {},
): 'legacy' | 'backend-staging' {
  const mode = environment[BROWSER_BINDING_MODE_ENV];
  if (mode === undefined || mode === '' || mode === 'legacy') return 'legacy';
  if (mode === 'backend-staging') return mode;
  throw new Error('BROWSER_BINDING_MODE_INVALID');
}

const version = z.number().int().min(0).max(2_147_483_647);
const opaqueToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const boundedCredential = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .max(maxBytes)
    .refine((credential) => new TextEncoder().encode(credential).byteLength <= maxBytes);
const identity = z.string().min(1).max(1024);
const metadata = {
  browserBindingProtocolVersion: z.literal(BROWSER_BINDING_PROTOCOL_VERSION),
  requestId: z.uuidv4(),
  issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
export const browserSourceCredentialSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('legacy-jwe'), credential: boundedCredential(BROWSER_BINDING_SOURCE_BYTES) }).strict(),
  z.object({ kind: z.literal('canonical-token'), token: boundedCredential(4096) }).strict(),
]);
export const browserSelectionPossessionSchema = z
  .object({ version, credential: browserSourceCredentialSchema })
  .strict();
export type BrowserSourceCredential = z.infer<typeof browserSourceCredentialSchema>;
export type BrowserSelectionPossession = z.infer<typeof browserSelectionPossessionSchema>;
const binding = { bindingToken: opaqueToken };
const actor = { actor: browserSelectionPossessionSchema.optional() };
export const browserBindingCommandSchema = z.discriminatedUnion('operation', [
  z.object({ ...metadata, operation: z.literal('bootstrap'), payload: z.object({}).strict() }).strict(),
  z.object({ ...metadata, operation: z.literal('describe'), payload: z.object(binding).strict() }).strict(),
  z
    .object({ ...metadata, operation: z.literal('read'), payload: z.object({ ...binding, ...actor }).strict() })
    .strict(),
  z
    .object({
      ...metadata,
      operation: z.literal('intent'),
      payload: z
        .object({
          ...binding,
          ...actor,
          transition: z.enum(['login', 'replacement', 'logout']),
          expectedVersion: version,
          expectedIdentity: z.object({ userId: identity, authSessionId: identity }).strict().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...metadata,
      operation: z.literal('login'),
      payload: z
        .object({
          ...binding,
          ...actor,
          intentToken: opaqueToken,
          candidate: browserSourceCredentialSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...metadata,
      operation: z.literal('logout'),
      payload: z
        .object({
          ...binding,
          intentToken: opaqueToken,
          actor: browserSelectionPossessionSchema,
        })
        .strict(),
    })
    .strict(),
]);
export type BrowserBindingCommand = z.infer<typeof browserBindingCommandSchema>;
export const browserBindingCursorSchema = z
  .object({
    bindingId: z.string().regex(/^[a-f0-9]{64}$/),
    version,
    bindingExpiresAt: z.iso.datetime(),
  })
  .strict();
const firstPartySession = z
  .object({
    userId: identity,
    authSessionId: identity,
    generation: version,
    authenticatedAt: z.iso.datetime().nullable(),
    expiresAt: z.iso.datetime(),
    linkGuarded: z.boolean(),
    requiresAccountCutoff: z.boolean(),
  })
  .strict();
const replyMetadata = {
  browserBindingProtocolVersion: z.literal(BROWSER_BINDING_PROTOCOL_VERSION),
  requestId: z.uuidv4(),
};
export const browserBindingReplySchema = z.union([
  z
    .object({
      ...replyMetadata,
      operation: z.literal('bootstrap'),
      outcome: z.literal('created'),
      token: opaqueToken,
      cursor: browserBindingCursorSchema,
    })
    .strict(),
  z
    .object({
      ...replyMetadata,
      operation: z.literal('describe'),
      outcome: z.literal('known'),
      state: z.enum(['anonymous', 'selected']),
      cursor: browserBindingCursorSchema,
      credentialKind: z.enum(['legacy-jwe', 'canonical-token']).nullable(),
    })
    .strict()
    .refine((reply) => (reply.state === 'anonymous') === (reply.credentialKind === null)),
  z
    .object({
      ...replyMetadata,
      operation: z.literal('read'),
      outcome: z.literal('admitted'),
      cursor: browserBindingCursorSchema,
      session: firstPartySession,
      user: z
        .object({
          id: identity,
          email: z.string().min(1).max(8192),
          name: z.string().nullable(),
          image: z.string().nullable(),
        })
        .strict(),
    })
    .strict()
    .refine((reply) => reply.user.id === reply.session.userId),
  z
    .object({
      ...replyMetadata,
      operation: z.literal('read'),
      outcome: z.literal('anonymous'),
      cursor: browserBindingCursorSchema,
    })
    .strict(),
  z
    .object({
      ...replyMetadata,
      operation: z.literal('intent'),
      outcome: z.literal('prepared'),
      intentToken: opaqueToken,
      cursor: browserBindingCursorSchema,
      expiresAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      ...replyMetadata,
      operation: z.enum(['login', 'logout']),
      outcome: z.enum(['committed', 'already-committed']),
      cursor: browserBindingCursorSchema,
      session: firstPartySession.nullable(),
    })
    .strict()
    .refine((reply) => (reply.operation === 'logout') === (reply.session === null)),
  z
    .object({
      ...replyMetadata,
      operation: z.enum(['bootstrap', 'describe', 'read', 'intent', 'login', 'logout']),
      outcome: z.enum(['denied', 'conflict', 'unavailable']),
    })
    .strict(),
]);
export type BrowserBindingReply = z.infer<typeof browserBindingReplySchema>;
export const browserBindingRejectionSchema = z
  .object({
    error: z.enum(['invalid_request', 'expired_request', 'unauthorized', 'disabled', 'unavailable']),
  })
  .strict();

export function browserBindingReplyStatus(reply: BrowserBindingReply): 200 | 201 | 401 | 409 | 503 {
  if (reply.outcome === 'created') return 201;
  if (reply.outcome === 'denied') return 401;
  if (reply.outcome === 'conflict') return 409;
  if (reply.outcome === 'unavailable') return 503;
  return 200;
}
