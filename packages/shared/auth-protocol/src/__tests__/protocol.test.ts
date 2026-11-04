import { describe, expect, it } from 'vitest';
import {
  authCommandReplyStatus,
  authCommandSchema,
  parseWebAuthMode,
  passwordReplySchema,
  registerReplySchema,
  registrationMailPlanSchema,
} from '../index';

const requestId = 'e363934b-b7ba-41ba-a279-52185daa100e';
const user = { id: 'selected-user', email: 'legacy stored address', name: null, image: null };

describe('two-command private contract', () => {
  it('keeps disabled mode configuration-free and rejects unknown activation modes', () => {
    for (const mode of [undefined, '', 'legacy']) expect(parseWebAuthMode(mode)).toBe('legacy');
    expect(parseWebAuthMode('backend-staging')).toBe('backend-staging');
    expect(() => parseWebAuthMode('true')).toThrow('Invalid current-store web auth mode');
  });
  it('keeps raw registration validation in backend, including primitives', () => {
    expect(
      authCommandSchema.parse({ requestId, issuedAt: 0, operation: 'register', payload: null }).payload,
    ).toBeNull();
    expect(authCommandSchema.safeParse({ requestId, issuedAt: 0, operation: 'register' }).success).toBe(false);
    expect(
      authCommandSchema.safeParse({ requestId, issuedAt: 0, operation: 'register', payload: {}, verified: true })
        .success,
    ).toBe(false);
  });
  it('accepts raw nonempty legacy password input without imposing registration rules', () => {
    expect(
      authCommandSchema.parse({
        requestId,
        issuedAt: 0,
        operation: 'password',
        payload: { email: ' stored ', password: 'x' },
      }).operation,
    ).toBe('password');
    expect(
      authCommandSchema.safeParse({
        requestId,
        issuedAt: 0,
        operation: 'password',
        payload: { email: 'x', password: 'x', verified: true },
      }).success,
    ).toBe(false);
  });
  it('binds verification to the selected user ID and rejects extra token metadata', () => {
    const reply = {
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
  it('requires exact committed recipient and legacy identifier without changing case', () => {
    const plan = {
      recipient: 'Climber@example.com',
      identifier: 'Climber@example.com',
      token: requestId,
      expiresAt: '2026-11-04T10:00:00.000Z',
    };
    expect(registrationMailPlanSchema.safeParse(plan).success).toBe(true);
    expect(registrationMailPlanSchema.safeParse({ ...plan, identifier: 'climber@example.com' }).success).toBe(false);
  });
  it('requires a mail plan only when verification is required', () => {
    const created = {
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
        operation: 'register',
        requestId,
        outcome: 'error',
        code: 'validation_error',
        message: 'secret password',
      }).success,
    ).toBe(false);
  });
});
