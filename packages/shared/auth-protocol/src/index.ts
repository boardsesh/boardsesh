import { z } from 'zod';

export { AUTH_BACKEND_UNAVAILABLE, isAuthBackendUnavailable } from './client-errors';
export * from './web-oauth-v1';
export * from './batch-system-user-v1';

export const AUTH_PROTOCOL_VERSION = 2;
export const AUTH_COMMAND_PATHS = {
  register: '/api/internal/auth/current-store/register',
  password: '/api/internal/auth/current-store/password',
  'verify-email': '/api/internal/auth/current-store/verify-email',
  'resend-verification': '/api/internal/auth/current-store/resend-verification',
  'forgot-password': '/api/internal/auth/current-store/forgot-password',
  'reset-password': '/api/internal/auth/current-store/reset-password',
} as const;
export const AUTH_COMMAND_ENV = {
  mode: 'CURRENT_STORE_WEB_AUTH_MODE',
  origin: 'CURRENT_STORE_AUTH_BACKEND_ORIGIN',
  secret: 'CURRENT_STORE_AUTH_RPC_SECRET',
} as const;
export const AUTH_COMMAND_REQUEST_BYTES = 16_384;
export const AUTH_COMMAND_RESPONSE_BYTES = 65_536;
export const AUTH_COMMAND_TIMEOUT_MS = 8_000;
export const AUTH_COMMAND_MAX_AGE_MS = 120_000;
export const AUTH_COMMAND_FUTURE_SKEW_MS = 5_000;
export const authProtocolRejectionSchema = z
  .object({ error: z.enum(['invalid_request', 'expired_request', 'unauthorized', 'disabled']) })
  .strict();

export type WebAuthMode = 'legacy' | 'backend-staging';
export function parseWebAuthMode(mode: string | undefined): WebAuthMode {
  if (mode === undefined || mode === '' || mode === 'legacy') return 'legacy';
  if (mode === 'backend-staging') return mode;
  throw new Error('Invalid current-store web auth mode');
}

const requestId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const issuedAt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identityId = z.string().min(1);
const isoTimestamp = z.iso.datetime();
const protocolVersion = z.literal(AUTH_PROTOCOL_VERSION);
const commandMetadata = { protocolVersion, requestId, issuedAt };

export const emailVerificationTokenSchema = z.string().regex(/^ev1_[A-Za-z0-9_-]{43}$/);
export const passwordRecoveryTokenSchema = z.string().regex(/^pr1_[A-Za-z0-9_-]{43}$/);
/** Reserve current, malformed and future recovery tokens before legacy dispatch. */
export function isVersionedPasswordRecoveryToken(token: unknown): boolean {
  return typeof token === 'string' && /^pr\d+_/i.test(token);
}
/** Reserve the namespace before any legacy dispatch, including future/malformed versions. */
export function isVersionedEmailVerificationToken(token: unknown): boolean {
  return typeof token === 'string' && /^ev\d+_/i.test(token);
}
/** Existing non-verification records must never reach the legacy orphan cleanup. */
export function isReservedAuthRecordIdentifier(identifier: unknown): boolean {
  return (
    typeof identifier === 'string' &&
    ['ba03-web-auth:', 'password-reset:', 'ba03-flow:', 'ba03-lineage:', 'ba03-batch-system-user:'].some((prefix) =>
      identifier.startsWith(prefix),
    )
  );
}

export const registerCommandSchema = z
  .object({
    ...commandMetadata,
    operation: z.literal('register'),
    payload: z.unknown(),
  })
  .strict()
  .refine((command) => Object.hasOwn(command, 'payload'), { message: 'Missing command payload' });
export const passwordCommandSchema = z
  .object({
    ...commandMetadata,
    operation: z.literal('password'),
    payload: z.object({ email: z.string().min(1), password: z.string().min(1) }).strict(),
  })
  .strict();
export const verifyEmailCommandSchema = z
  .object({
    ...commandMetadata,
    operation: z.literal('verify-email'),
    payload: z.object({ token: z.string().min(1).max(256), email: z.string().min(1).optional() }).strict(),
  })
  .strict();
export const resendVerificationCommandSchema = z
  .object({
    ...commandMetadata,
    operation: z.literal('resend-verification'),
    payload: z.unknown(),
  })
  .strict()
  .refine((command) => Object.hasOwn(command, 'payload'), { message: 'Missing command payload' });
export const forgotPasswordCommandSchema = z
  .object({ ...commandMetadata, operation: z.literal('forgot-password'), payload: z.unknown() })
  .strict()
  .refine((command) => Object.hasOwn(command, 'payload'), { message: 'Missing command payload' });
export const resetPasswordCommandSchema = z
  .object({ ...commandMetadata, operation: z.literal('reset-password'), payload: z.unknown() })
  .strict()
  .refine((command) => Object.hasOwn(command, 'payload'), { message: 'Missing command payload' });
export const authCommandSchema = z.union([
  registerCommandSchema,
  passwordCommandSchema,
  verifyEmailCommandSchema,
  resendVerificationCommandSchema,
  forgotPasswordCommandSchema,
  resetPasswordCommandSchema,
]);

/** Private RPC data. Public HTTP adapters must project a separate response. */
export const registrationMailPlanSchema = z
  .object({
    kind: z.literal('uid-email-verification-v1'),
    recipient: z.email(),
    token: emailVerificationTokenSchema,
    expiresAt: isoTimestamp,
  })
  .strict();
export const emailVerificationMailPlanSchema = registrationMailPlanSchema;
export const passwordRecoveryMailPlanSchema = z
  .object({
    kind: z.literal('uid-password-reset-v1'),
    recipient: z.email(),
    token: passwordRecoveryTokenSchema,
    expiresAt: isoTimestamp,
  })
  .strict();

export const REGISTRATION_VALIDATION_MESSAGES = [
  'Invalid email address',
  'Password must be at least 8 characters',
  'Password must be less than 128 characters',
  'Name is required',
  'Name must be less than 100 characters',
  'Invalid input: expected string, received undefined',
  'Invalid input: expected string, received null',
  'Invalid input: expected string, received number',
  'Invalid input: expected string, received boolean',
  'Invalid input: expected string, received object',
  'Invalid input: expected string, received array',
  'Invalid input: expected object, received undefined',
  'Invalid input: expected object, received null',
  'Invalid input: expected object, received number',
  'Invalid input: expected object, received boolean',
  'Invalid input: expected object, received string',
  'Invalid input: expected object, received array',
] as const;
export const PASSWORD_RECOVERY_VALIDATION_MESSAGES = [
  ...REGISTRATION_VALIDATION_MESSAGES,
  'Invalid reset token',
  'Passwords do not match',
] as const;

function transportErrorReplySchema<const Operation extends keyof typeof AUTH_COMMAND_PATHS>(operation: Operation) {
  const base = { protocolVersion, operation: z.literal(operation), requestId, outcome: z.literal('error') };
  return z.discriminatedUnion('code', [
    z.object({ ...base, code: z.literal('replayed') }).strict(),
    z
      .object({ ...base, code: z.literal('rate_limited'), retryAfterSeconds: z.number().int().min(1).max(3600) })
      .strict(),
    z.object({ ...base, code: z.literal('unavailable') }).strict(),
  ]);
}

const registerCreated = {
  protocolVersion,
  operation: z.literal('register'),
  requestId,
  outcome: z.literal('created'),
  userId: identityId,
  createdAt: isoTimestamp,
};
export const registerReplySchema = z.union([
  z.object({ ...registerCreated, requiresVerification: z.literal(false) }).strict(),
  z
    .object({ ...registerCreated, requiresVerification: z.literal(true), mailPlan: registrationMailPlanSchema })
    .strict(),
  z
    .object({
      protocolVersion,
      operation: z.literal('register'),
      requestId,
      outcome: z.literal('error'),
      code: z.literal('validation_error'),
      message: z.enum(REGISTRATION_VALIDATION_MESSAGES),
    })
    .strict(),
  z
    .object({
      protocolVersion,
      operation: z.literal('register'),
      requestId,
      outcome: z.literal('error'),
      code: z.literal('exists'),
    })
    .strict(),
  transportErrorReplySchema('register'),
]);

export const passwordReplySchema = z.union([
  z
    .object({ protocolVersion, operation: z.literal('password'), requestId, outcome: z.literal('invalid_credentials') })
    .strict(),
  z
    .object({
      protocolVersion,
      operation: z.literal('password'),
      requestId,
      outcome: z.literal('authenticated'),
      user: z
        .object({ id: identityId, email: z.string().min(1), name: z.string().nullable(), image: z.string().nullable() })
        .strict(),
      verification: z.object({ userId: identityId, required: z.boolean(), verified: z.boolean() }).strict(),
    })
    .strict()
    .refine((reply) => reply.user.id === reply.verification.userId, { message: 'Verification identity mismatch' }),
  transportErrorReplySchema('password'),
]);

export const verifyEmailReplySchema = z.union([
  z
    .object({
      protocolVersion,
      operation: z.literal('verify-email'),
      requestId,
      outcome: z.enum(['verified', 'invalid_token', 'expired', 'legacy_unbound']),
    })
    .strict(),
  transportErrorReplySchema('verify-email'),
]);
export const resendVerificationReplySchema = z.union([
  z
    .object({
      protocolVersion,
      operation: z.literal('resend-verification'),
      requestId,
      outcome: z.literal('accepted'),
      mailPlan: emailVerificationMailPlanSchema.optional(),
    })
    .strict(),
  z
    .object({
      protocolVersion,
      operation: z.literal('resend-verification'),
      requestId,
      outcome: z.literal('error'),
      code: z.literal('validation_error'),
      message: z.enum(REGISTRATION_VALIDATION_MESSAGES),
    })
    .strict(),
  transportErrorReplySchema('resend-verification'),
]);
function recoveryValidationReply<const Operation extends 'forgot-password' | 'reset-password'>(operation: Operation) {
  return z
    .object({
      protocolVersion,
      operation: z.literal(operation),
      requestId,
      outcome: z.literal('error'),
      code: z.literal('validation_error'),
      message: z.enum(PASSWORD_RECOVERY_VALIDATION_MESSAGES),
    })
    .strict();
}
export const forgotPasswordReplySchema = z.union([
  z
    .object({
      protocolVersion,
      operation: z.literal('forgot-password'),
      requestId,
      outcome: z.literal('accepted'),
      mailPlan: passwordRecoveryMailPlanSchema.optional(),
    })
    .strict(),
  recoveryValidationReply('forgot-password'),
  transportErrorReplySchema('forgot-password'),
]);
export const resetPasswordReplySchema = z.union([
  z
    .object({
      protocolVersion,
      operation: z.literal('reset-password'),
      requestId,
      outcome: z.enum(['reset', 'invalid_or_expired', 'legacy_unbound']),
    })
    .strict(),
  recoveryValidationReply('reset-password'),
  transportErrorReplySchema('reset-password'),
]);
export const authCommandReplySchema = z.union([
  registerReplySchema,
  passwordReplySchema,
  verifyEmailReplySchema,
  resendVerificationReplySchema,
  forgotPasswordReplySchema,
  resetPasswordReplySchema,
]);

export type RegisterCommand = z.infer<typeof registerCommandSchema>;
export type PasswordCommand = z.infer<typeof passwordCommandSchema>;
export type VerifyEmailCommand = z.infer<typeof verifyEmailCommandSchema>;
export type ResendVerificationCommand = z.infer<typeof resendVerificationCommandSchema>;
export type ForgotPasswordCommand = z.infer<typeof forgotPasswordCommandSchema>;
export type ResetPasswordCommand = z.infer<typeof resetPasswordCommandSchema>;
export type AuthCommand = z.infer<typeof authCommandSchema>;
export type RegistrationMailPlan = z.infer<typeof registrationMailPlanSchema>;
export type RegisterReply = z.infer<typeof registerReplySchema>;
export type PasswordReply = z.infer<typeof passwordReplySchema>;
export type VerifyEmailReply = z.infer<typeof verifyEmailReplySchema>;
export type ResendVerificationReply = z.infer<typeof resendVerificationReplySchema>;
export type ForgotPasswordReply = z.infer<typeof forgotPasswordReplySchema>;
export type ResetPasswordReply = z.infer<typeof resetPasswordReplySchema>;
export type PasswordRecoveryMailPlan = z.infer<typeof passwordRecoveryMailPlanSchema>;
export type AuthCommandReply = z.infer<typeof authCommandReplySchema>;

export function authCommandReplyStatus(reply: AuthCommandReply): number {
  if (reply.outcome === 'legacy_unbound') return 503;
  if (reply.outcome === 'created') return 201;
  if (reply.outcome !== 'error') return 200;
  if (reply.code === 'validation_error') return 400;
  if (reply.code === 'exists' || reply.code === 'replayed') return 409;
  if (reply.code === 'rate_limited') return 429;
  return 503;
}
