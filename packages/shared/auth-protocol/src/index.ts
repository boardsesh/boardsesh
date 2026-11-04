import { z } from 'zod';

export { AUTH_BACKEND_UNAVAILABLE, isAuthBackendUnavailable } from './client-errors';

export const AUTH_COMMAND_PATHS = {
  register: '/api/internal/auth/current-store/register',
  password: '/api/internal/auth/current-store/password',
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

export const registerCommandSchema = z
  .object({
    requestId,
    issuedAt,
    operation: z.literal('register'),
    payload: z.unknown(),
  })
  .strict()
  .refine((command) => Object.hasOwn(command, 'payload'), { message: 'Missing command payload' });
export const passwordCommandSchema = z
  .object({
    requestId,
    issuedAt,
    operation: z.literal('password'),
    payload: z.object({ email: z.string().min(1), password: z.string().min(1) }).strict(),
  })
  .strict();
export const authCommandSchema = z.union([registerCommandSchema, passwordCommandSchema]);

/** Private RPC data. Public HTTP adapters must project a separate response. */
export const registrationMailPlanSchema = z
  .object({
    recipient: z.email(),
    identifier: z.string().min(1),
    token: requestId,
    expiresAt: isoTimestamp,
  })
  .strict()
  .refine((plan) => plan.recipient === plan.identifier, { message: 'Mail identity mismatch' });

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

function transportErrorReplySchema<const Operation extends 'register' | 'password'>(operation: Operation) {
  const base = { operation: z.literal(operation), requestId, outcome: z.literal('error') };
  return z.discriminatedUnion('code', [
    z.object({ ...base, code: z.literal('replayed') }).strict(),
    z
      .object({ ...base, code: z.literal('rate_limited'), retryAfterSeconds: z.number().int().min(1).max(3600) })
      .strict(),
    z.object({ ...base, code: z.literal('unavailable') }).strict(),
  ]);
}

const registerCreated = {
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
      operation: z.literal('register'),
      requestId,
      outcome: z.literal('error'),
      code: z.literal('validation_error'),
      message: z.enum(REGISTRATION_VALIDATION_MESSAGES),
    })
    .strict(),
  z
    .object({ operation: z.literal('register'), requestId, outcome: z.literal('error'), code: z.literal('exists') })
    .strict(),
  transportErrorReplySchema('register'),
]);

export const passwordReplySchema = z.union([
  z.object({ operation: z.literal('password'), requestId, outcome: z.literal('invalid_credentials') }).strict(),
  z
    .object({
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

export type RegisterCommand = z.infer<typeof registerCommandSchema>;
export type PasswordCommand = z.infer<typeof passwordCommandSchema>;
export type AuthCommand = z.infer<typeof authCommandSchema>;
export type RegistrationMailPlan = z.infer<typeof registrationMailPlanSchema>;
export type RegisterReply = z.infer<typeof registerReplySchema>;
export type PasswordReply = z.infer<typeof passwordReplySchema>;
export type AuthCommandReply = RegisterReply | PasswordReply;

export function authCommandReplyStatus(reply: AuthCommandReply): number {
  if (reply.outcome === 'created') return 201;
  if (reply.outcome !== 'error') return 200;
  if (reply.code === 'validation_error') return 400;
  if (reply.code === 'exists' || reply.code === 'replayed') return 409;
  if (reply.code === 'rate_limited') return 429;
  return 503;
}
