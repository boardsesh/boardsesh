import { z } from 'zod';
import { webCredentialProofSchema } from './web-credential-proof';

export const FIRST_PASSWORD_VERSION = 1;
export const FIRST_PASSWORD_PATH_PREFIX = '/api/internal/auth/current-store/first-password/v1';
export const FIRST_PASSWORD_REQUEST_BYTES = 65_536;
export const FIRST_PASSWORD_RESPONSE_BYTES = 65_536;
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
const credential = z
  .string()
  .min(1)
  .max(16_384)
  .refine((raw) => new TextEncoder().encode(raw).byteLength <= 16_384);
const sourceKind = z.enum(['legacy-jwe', 'canonical-token']);
const actor = z
  .object({
    kind: sourceKind,
    credential,
    expectedUserId: z.string().min(1).max(1024),
    expectedAuthSessionId: z.string().min(1).max(1024),
    browserBindingToken: token,
    browserVersion: z.number().int().nonnegative().max(2_147_483_646),
  })
  .strict();
const candidate = z.object({ kind: sourceKind, credential }).strict();
const bound = { actor, challengeToken: token, browserIntentToken: token };
const metadata = {
  firstPasswordVersion: z.literal(FIRST_PASSWORD_VERSION),
  requestId: z.uuidv4(),
  issuedAt: timestamp,
};
const command = <Operation extends string, Shape extends z.ZodRawShape>(operation: Operation, payload: Shape) =>
  z.object({ ...metadata, operation: z.literal(operation), payload: z.object(payload).strict() }).strict();
export const firstPasswordCommandSchema = z.discriminatedUnion('operation', [
  command('request', { actor }),
  command('read', bound),
  command('prepare', {
    ...bound,
    confirmationToken: token,
    password: z.string().min(8).max(128),
    confirmPassword: z.string().min(8).max(128),
  }),
  command('finalize', { ...bound, preparationToken: token, candidate }),
  command('recover', { ...bound, preparationToken: token, recoveryToken: token, candidate }),
]);
export type FirstPasswordCommand = z.infer<typeof firstPasswordCommandSchema>;
export type FirstPasswordOperation = FirstPasswordCommand['operation'];
export const FIRST_PASSWORD_COMMAND_PATHS = {
  request: `${FIRST_PASSWORD_PATH_PREFIX}/request`,
  read: `${FIRST_PASSWORD_PATH_PREFIX}/read`,
  prepare: `${FIRST_PASSWORD_PATH_PREFIX}/prepare`,
  finalize: `${FIRST_PASSWORD_PATH_PREFIX}/finalize`,
  recover: `${FIRST_PASSWORD_PATH_PREFIX}/recover`,
} as const satisfies Record<FirstPasswordOperation, string>;
const replyMetadata = { firstPasswordVersion: z.literal(FIRST_PASSWORD_VERSION), requestId: z.uuidv4() };
const browserCursor = z
  .object({
    bindingId: digest,
    version: z.number().int().nonnegative().max(2_147_483_647),
    bindingExpiresAt: timestamp,
  })
  .strict();
const operation = z.enum(['request', 'read', 'prepare', 'finalize', 'recover']);
const reply = <Operation extends FirstPasswordOperation, Shape extends z.ZodRawShape>(
  operation: Operation,
  fields: Shape,
) => z.object({ ...replyMetadata, operation: z.literal(operation), ...fields }).strict();
export const firstPasswordReplySchema = z.union([
  z
    .object({
      ...replyMetadata,
      operation,
      outcome: z.enum(['unauthenticated', 'identity_changed', 'denied', 'unavailable']),
      code: z.enum([
        'not_eligible',
        'already_set',
        'email_changed',
        'invalid_proof',
        'expired',
        'replayed',
        'authority_unavailable',
      ]),
    })
    .strict(),
  reply('request', {
    outcome: z.literal('issued'),
    challengeToken: token,
    recoveryToken: token,
    browserIntentToken: token,
    browserCursor,
    expiresAt: timestamp,
    /** Internal delivery plan only; never serialize this private reply to a browser. */
    mailPlan: z
      .object({ kind: z.literal('uid-first-password-v1'), recipient: z.email().max(8192), token, expiresAt: timestamp })
      .strict(),
  }),
  reply('read', { outcome: z.enum(['pending', 'prepared']), expiresAt: timestamp, browserCursor }),
  reply('prepare', {
    outcome: z.literal('prepared'),
    preparationToken: token,
    credentialProof: webCredentialProofSchema,
    credentialExpiresAt: timestamp,
    expiresAt: timestamp,
    browserCursor,
    proposedCanonicalToken: token.nullable(),
    user: z
      .object({
        id: z.string().min(1).max(1024),
        email: z.string().min(1).max(8192),
        name: z.string().max(8192).nullable(),
        image: z.string().max(8192).nullable(),
        emailVerified: timestamp.nullable(),
        createdAt: timestamp,
      })
      .strict(),
  }),
  reply('finalize', { outcome: z.literal('committed'), candidateCredentialHash: digest, browserCursor }),
  reply('recover', { outcome: z.literal('recovered'), candidateCredentialHash: digest, browserCursor }),
]);
export type FirstPasswordReply = z.infer<typeof firstPasswordReplySchema>;
export function firstPasswordReplyStatus(reply: FirstPasswordReply): 200 | 400 | 401 | 409 | 503 {
  if (reply.outcome === 'unavailable') return 503;
  if (reply.outcome === 'unauthenticated') return 401;
  if (reply.outcome === 'identity_changed') return 409;
  if (reply.outcome === 'denied') return 400;
  return 200;
}
export function firstPasswordMode(
  environment: Readonly<Record<string, string | undefined>>,
): 'legacy' | 'backend-staging' {
  const mode = environment.CURRENT_STORE_FIRST_PASSWORD_MODE;
  if (!mode || mode === 'legacy') return 'legacy';
  if (mode === 'backend-staging') return mode;
  throw new Error('Invalid CURRENT_STORE_FIRST_PASSWORD_MODE');
}
