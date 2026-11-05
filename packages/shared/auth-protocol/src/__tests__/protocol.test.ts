import { describe, expect, it } from 'vitest';
import {
  authCommandReplyStatus,
  authCommandSchema,
  parseWebAuthMode,
  passwordReplySchema,
  registerReplySchema,
  registrationMailPlanSchema,
  verifyEmailReplySchema,
  resendVerificationReplySchema,
  isVersionedEmailVerificationToken,
  emailVerificationTokenSchema,
  isReservedAuthRecordIdentifier,
} from '../index';

const requestId = 'e363934b-b7ba-41ba-a279-52185daa100e';
const user = { id: 'selected-user', email: 'legacy stored address', name: null, image: null };

describe('versioned four-command private contract', () => {
  it('keeps disabled mode configuration-free and rejects unknown activation modes', () => {
    for (const mode of [undefined, '', 'legacy']) expect(parseWebAuthMode(mode)).toBe('legacy');
    expect(parseWebAuthMode('backend-staging')).toBe('backend-staging');
    expect(() => parseWebAuthMode('true')).toThrow('Invalid current-store web auth mode');
  });
  it('keeps raw registration validation in backend, including primitives', () => {
    expect(
      authCommandSchema.parse({ requestId, issuedAt: 0, protocolVersion: 2, operation: 'register', payload: null })
        .payload,
    ).toBeNull();
    expect(
      authCommandSchema.safeParse({ requestId, issuedAt: 0, protocolVersion: 2, operation: 'register' }).success,
    ).toBe(false);
    expect(
      authCommandSchema.safeParse({
        requestId,
        issuedAt: 0,
        protocolVersion: 2,
        operation: 'register',
        payload: {},
        verified: true,
      }).success,
    ).toBe(false);
  });
  it('accepts raw nonempty legacy password input without imposing registration rules', () => {
    expect(
      authCommandSchema.parse({
        requestId,
        issuedAt: 0,
        protocolVersion: 2,
        operation: 'password',
        payload: { email: ' stored ', password: 'x' },
      }).operation,
    ).toBe('password');
    expect(
      authCommandSchema.safeParse({
        requestId,
        issuedAt: 0,
        protocolVersion: 2,
        operation: 'password',
        payload: { email: 'x', password: 'x', verified: true },
      }).success,
    ).toBe(false);
  });
  it('binds verification to the selected user ID and rejects extra token metadata', () => {
    const reply = {
      protocolVersion: 2,
      operation: 'password',
      requestId,
      outcome: 'authenticated',
      user,
      verification: { userId: user.id, required: true, verified: false },
    };
    expect(passwordReplySchema.safeParse(reply).success).toBe(true);
    expect(
      passwordReplySchema.safeParse({ ...reply, verification: { ...reply.verification, userId: 'other' } }).success,
    ).toBe(false);
    expect(passwordReplySchema.safeParse({ ...reply, token: 'private' }).success).toBe(false);
  });
  it('requires the versioned UID mail kind and URL-safe token without a legacy identifier', () => {
    const plan = {
      kind: 'uid-email-verification-v1',
      recipient: 'Climber@example.com',
      token: `ev1_${'A'.repeat(43)}`,
      expiresAt: '2026-11-04T10:00:00.000Z',
    };
    expect(registrationMailPlanSchema.safeParse(plan).success).toBe(true);
    expect(registrationMailPlanSchema.safeParse({ ...plan, identifier: 'climber@example.com' }).success).toBe(false);
    expect(registrationMailPlanSchema.safeParse({ ...plan, token: requestId }).success).toBe(false);
    expect(registrationMailPlanSchema.safeParse({ ...plan, kind: 'legacy' }).success).toBe(false);
  });
  it('requires a mail plan only when verification is required', () => {
    const created = {
      protocolVersion: 2,
      operation: 'register',
      requestId,
      outcome: 'created',
      userId: user.id,
      createdAt: '2026-11-04T10:00:00.000Z',
    };
    expect(registerReplySchema.safeParse({ ...created, requiresVerification: true }).success).toBe(false);
    expect(registerReplySchema.safeParse({ ...created, requiresVerification: false, mailPlan: {} }).success).toBe(
      false,
    );
    expect(authCommandReplyStatus(registerReplySchema.parse({ ...created, requiresVerification: false }))).toBe(201);
  });
  it.each([
    ['validation_error', 400],
    ['exists', 409],
    ['replayed', 409],
    ['rate_limited', 429],
    ['unavailable', 503],
  ] as const)('maps %s to its exact HTTP status', (code, status) => {
    const reply = registerReplySchema.parse({
      protocolVersion: 2,
      operation: 'register',
      requestId,
      outcome: 'error',
      code,
      ...(code === 'validation_error' ? { message: 'Invalid email address' } : {}),
      ...(code === 'rate_limited' ? { retryAfterSeconds: 1 } : {}),
    });
    expect(authCommandReplyStatus(reply)).toBe(status);
  });
  it('rejects reflected free-form validation errors', () => {
    expect(
      registerReplySchema.safeParse({
        protocolVersion: 2,
        operation: 'register',
        requestId,
        outcome: 'error',
        code: 'validation_error',
        message: 'secret password',
      }).success,
    ).toBe(false);
  });
  it.each(['register', 'password', 'verify-email', 'resend-verification'] as const)(
    'requires JSON body version2 for %s, not a permissive absent/default version',
    (operation) => {
      const command = {
        requestId,
        issuedAt: 0,
        operation,
        payload:
          operation === 'password'
            ? { email: 'legacy', password: 'x' }
            : operation === 'verify-email'
              ? { token: `ev1_${'A'.repeat(43)}` }
              : {},
      };
      expect(authCommandSchema.safeParse(command).success).toBe(false);
      expect(authCommandSchema.safeParse({ ...command, protocolVersion: 1 }).success).toBe(false);
      expect(authCommandSchema.safeParse({ ...command, protocolVersion: 2 }).success).toBe(true);
    },
  );
  it('reserves malformed and future namespaces independently of strict current token validation', () => {
    for (const token of ['ev1_short', 'ev2_future', 'EV1_upper', 'ev999_']) {
      expect(isVersionedEmailVerificationToken(token)).toBe(true);
      expect(emailVerificationTokenSchema.safeParse(token).success).toBe(false);
    }
    expect(isVersionedEmailVerificationToken(requestId)).toBe(false);
    expect(emailVerificationTokenSchema.safeParse(`ev1_${'A'.repeat(43)}`).success).toBe(true);
  });
  it('keeps private verification replies finite and explicitly versioned', () => {
    const verified = { protocolVersion: 2, requestId, operation: 'verify-email', outcome: 'verified' };
    expect(verifyEmailReplySchema.safeParse(verified).success).toBe(true);
    expect(verifyEmailReplySchema.safeParse({ ...verified, userId: 'private' }).success).toBe(false);
    expect(verifyEmailReplySchema.safeParse({ ...verified, protocolVersion: 1 }).success).toBe(false);
    expect(authCommandReplyStatus(verifyEmailReplySchema.parse({ ...verified, outcome: 'legacy_unbound' }))).toBe(503);
  });
  it('admits a generic resend outcome without a mail plan and rejects legacy mail plans', () => {
    const accepted = { protocolVersion: 2, requestId, operation: 'resend-verification', outcome: 'accepted' };
    expect(resendVerificationReplySchema.safeParse(accepted).success).toBe(true);
    expect(
      resendVerificationReplySchema.safeParse({
        ...accepted,
        mailPlan: {
          recipient: 'legacy@example.com',
          identifier: 'legacy@example.com',
          token: requestId,
          expiresAt: '2026-11-05T10:00:00.000Z',
        },
      }).success,
    ).toBe(false);
  });
  it('recognizes only the known non-verification identifier namespaces', () => {
    for (const identifier of [
      'ba03-web-auth:hash',
      'password-reset:email',
      'ba03-flow:nonce',
      'ba03-lineage:nonce',
      'ba03-batch-system-user:v1:hash',
      'ba03-batch-system-user:v999:future',
    ]) {
      expect(isReservedAuthRecordIdentifier(identifier)).toBe(true);
    }
    expect(isReservedAuthRecordIdentifier('unusual historical address')).toBe(false);
  });
});
