import { z } from 'zod';
import { webCredentialProofSchema } from './web-credential-proof';

export const PROVIDER_SECURITY_VERSION = 1;
export const PROVIDER_SECURITY_PATH_PREFIX = '/api/internal/auth/current-store/provider-security/v1';
export const PROVIDER_SECURITY_REQUEST_BYTES = 196_608;
export const PROVIDER_SECURITY_RESPONSE_BYTES = 131_072;
export const PROVIDER_SECURITY_PROVIDERS = ['google', 'apple'] as const;
export const providerSecurityProviderSchema = z.enum(PROVIDER_SECURITY_PROVIDERS);
export type ProviderSecurityProvider = z.infer<typeof providerSecurityProviderSchema>;

const credential = z.string().min(1).max(65_536);
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
const subject = z.string().min(1).max(1024);
const actor = z
  .object({
    kind: z.enum(['legacy-jwe', 'canonical-token']),
    credential,
    expectedUserId: z.string().min(1).max(1024),
    expectedAuthSessionId: z.string().min(1).max(1024),
    browserBindingToken: token,
    browserVersion: z.number().int().nonnegative().max(2_147_483_646),
  })
  .strict();
const metadata = {
  providerSecurityVersion: z.literal(PROVIDER_SECURITY_VERSION),
  requestId: z.uuidv4(),
  issuedAt: timestamp,
};
const command = <Operation extends string, Shape extends z.ZodRawShape>(operation: Operation, payload: Shape) =>
  z.object({ ...metadata, operation: z.literal(operation), payload: z.object(payload).strict() }).strict();
const bound = { actor, intentToken: token, browserIntentToken: token };

export const providerSecurityCommandSchema = z.discriminatedUnion('operation', [
  command('methods', { actor }),
  command('owned-provider', { actor, provider: providerSecurityProviderSchema, subject }),
  command('intent', {
    actor,
    action: z.enum(['link', 'unlink']),
    provider: providerSecurityProviderSchema,
    methodId: digest.nullable(),
  }),
  command('bind', { ...bound, flowHash: digest }),
  command('bind-google-reauthentication', { ...bound, flowHash: digest, nonceHash: digest }),
  command('reauthenticate-password', { ...bound, password: z.string().min(1).max(16_384) }),
  command('reauthenticate-google', {
    ...bound,
    flowHash: digest,
    nonce: z.string().min(1).max(1024),
    idToken: z.string().min(1).max(16_384),
  }),
  command('prepare', {
    ...bound,
    reauthenticationToken: token,
    flowHash: digest.nullable(),
    providerProof: z
      .object({
        provider: providerSecurityProviderSchema,
        subject,
        email: z.string().min(1).max(8192).nullable(),
        emailVerified: z.boolean(),
      })
      .strict()
      .nullable(),
  }),
  command('finalize', {
    ...bound,
    reauthenticationToken: token,
    preparationToken: token,
    candidate: z.object({ kind: z.enum(['legacy-jwe', 'canonical-token']), credential }).strict(),
  }),
  command('abort', { ...bound, preparationToken: token.nullable(), flowHash: digest.nullable() }),
  command('recover', {
    ...bound,
    recoveryToken: token,
    reauthenticationToken: token,
    candidate: z.object({ kind: z.enum(['legacy-jwe', 'canonical-token']), credential }).strict(),
  }),
]);
export type ProviderSecurityCommand = z.infer<typeof providerSecurityCommandSchema>;
export type ProviderSecurityOperation = ProviderSecurityCommand['operation'];
export type ProviderSecurityActor = ProviderSecurityCommand['payload']['actor'];

export const PROVIDER_SECURITY_COMMAND_PATHS = {
  methods: `${PROVIDER_SECURITY_PATH_PREFIX}/methods`,
  'owned-provider': `${PROVIDER_SECURITY_PATH_PREFIX}/owned-provider`,
  intent: `${PROVIDER_SECURITY_PATH_PREFIX}/intent`,
  bind: `${PROVIDER_SECURITY_PATH_PREFIX}/bind`,
  'bind-google-reauthentication': `${PROVIDER_SECURITY_PATH_PREFIX}/bind-google-reauthentication`,
  'reauthenticate-password': `${PROVIDER_SECURITY_PATH_PREFIX}/reauthenticate-password`,
  'reauthenticate-google': `${PROVIDER_SECURITY_PATH_PREFIX}/reauthenticate-google`,
  prepare: `${PROVIDER_SECURITY_PATH_PREFIX}/prepare`,
  finalize: `${PROVIDER_SECURITY_PATH_PREFIX}/finalize`,
  abort: `${PROVIDER_SECURITY_PATH_PREFIX}/abort`,
  recover: `${PROVIDER_SECURITY_PATH_PREFIX}/recover`,
} as const satisfies Record<ProviderSecurityOperation, string>;

const replyMetadata = {
  providerSecurityVersion: z.literal(PROVIDER_SECURITY_VERSION),
  requestId: z.uuidv4(),
};
const browserCursor = z
  .object({
    bindingId: digest,
    version: z.number().int().nonnegative().max(2_147_483_647),
    bindingExpiresAt: timestamp,
  })
  .strict();
const operation = z.enum([
  'methods',
  'owned-provider',
  'intent',
  'bind',
  'bind-google-reauthentication',
  'reauthenticate-password',
  'reauthenticate-google',
  'prepare',
  'finalize',
  'abort',
  'recover',
]);
const failure = z
  .object({
    ...replyMetadata,
    operation,
    outcome: z.enum([
      'unauthenticated',
      'identity_changed',
      'reauthentication_required',
      'reauthentication_unavailable',
      'denied',
      'unavailable',
    ]),
    code: z.enum([
      'invalid_intent',
      'invalid_proof',
      'expired',
      'replayed',
      'provider_unavailable',
      'provider_not_verified',
      'ownership_conflict',
      'last_usable_method',
      'authority_unavailable',
    ]),
  })
  .strict();
const method = z
  .object({ methodId: digest, provider: providerSecurityProviderSchema, usable: z.boolean(), canUnlink: z.boolean() })
  .strict();
const providerUser = z
  .object({
    id: subject,
    email: z.string().min(1),
    name: z.string().nullable(),
    image: z.string().nullable(),
    emailVerified: timestamp.nullable(),
    createdAt: timestamp,
  })
  .strict();
export const providerSecurityReplySchema = z.union([
  failure,
  z
    .object({
      ...replyMetadata,
      operation: z.literal('owned-provider'),
      outcome: z.literal('owned'),
      credentialProof: webCredentialProofSchema,
      credentialExpiresAt: timestamp,
      browserCursor,
      user: providerUser,
    })
    .strict(),
  z
    .object({
      ...replyMetadata,
      operation: z.literal('methods'),
      outcome: z.literal('available'),
      passwordUsable: z.boolean(),
      providers: z.array(method).max(1000),
      configuredProviders: z.array(providerSecurityProviderSchema).max(2),
      googleReauthenticationAvailable: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...replyMetadata,
      operation: z.literal('intent'),
      outcome: z.literal('recorded'),
      intentToken: token,
      recoveryToken: token,
      browserIntentToken: token,
      browserCursor,
      expiresAt: timestamp,
    })
    .strict(),
  z
    .object({
      ...replyMetadata,
      operation: z.enum(['bind', 'bind-google-reauthentication']),
      outcome: z.literal('bound'),
    })
    .strict(),
  z
    .object({
      ...replyMetadata,
      operation: z.enum(['reauthenticate-password', 'reauthenticate-google']),
      outcome: z.literal('proved'),
      reauthenticationToken: token,
      expiresAt: timestamp,
    })
    .strict(),
  z
    .object({
      ...replyMetadata,
      operation: z.literal('prepare'),
      outcome: z.literal('prepared'),
      preparationToken: token,
      credentialProof: webCredentialProofSchema,
      credentialExpiresAt: timestamp,
      expiresAt: timestamp,
      browserCursor,
      /** An opaque canonical token is proposed privately, never inferred from a SID. */
      proposedCanonicalToken: token.nullable(),
      user: providerUser,
    })
    .strict(),
  z
    .object({
      ...replyMetadata,
      operation: z.literal('finalize'),
      outcome: z.literal('committed'),
      candidateCredentialHash: digest,
      browserCursor,
    })
    .strict(),
  z.object({ ...replyMetadata, operation: z.literal('abort'), outcome: z.literal('aborted') }).strict(),
  z
    .object({
      ...replyMetadata,
      operation: z.literal('recover'),
      outcome: z.literal('recovered'),
      candidateCredentialHash: digest,
      browserCursor,
    })
    .strict(),
]);
export type ProviderSecurityReply = z.infer<typeof providerSecurityReplySchema>;

export function providerSecurityReplyStatus(reply: ProviderSecurityReply): 200 | 400 | 401 | 403 | 409 | 503 {
  switch (reply.outcome) {
    case 'unauthenticated':
      return 401;
    case 'identity_changed':
      return 409;
    case 'reauthentication_required':
    case 'reauthentication_unavailable':
      return 403;
    case 'denied':
      return 400;
    case 'unavailable':
      return 503;
    default:
      return 200;
  }
}

export function providerSecurityMode(
  environment: Readonly<Record<string, string | undefined>>,
): 'legacy' | 'backend-staging' {
  const mode = environment.CURRENT_STORE_PROVIDER_SECURITY_MODE;
  if (!mode || mode === 'legacy') return 'legacy';
  if (mode === 'backend-staging') return mode;
  throw new Error('Invalid CURRENT_STORE_PROVIDER_SECURITY_MODE');
}
