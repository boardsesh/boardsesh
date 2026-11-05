import { describe, expect, it } from 'vite-plus/test';
import {
  authCommandSchema,
  authCommandReplyStatus,
  forgotPasswordReplySchema,
  resetPasswordReplySchema,
  passwordRecoveryMailPlanSchema,
  passwordRecoveryTokenSchema,
  isVersionedPasswordRecoveryToken,
} from '../index';

const requestId = 'e363934b-b7ba-41ba-a279-52185daa100e';
const metadata = { protocolVersion: 2, requestId, issuedAt: 0 };

describe('additive v2 recovery commands', () => {
  it.each(['forgot-password', 'reset-password'] as const)(
    'requires body version, payload and strict envelope for %s',
    (operation) => {
      expect(authCommandSchema.safeParse({ ...metadata, operation, payload: null }).success).toBe(true);
      expect(authCommandSchema.safeParse({ ...metadata, operation }).success).toBe(false);
      expect(authCommandSchema.safeParse({ ...metadata, protocolVersion: 1, operation, payload: {} }).success).toBe(
        false,
      );
      expect(authCommandSchema.safeParse({ requestId, issuedAt: 0, operation, payload: {} }).success).toBe(false);
      expect(
        authCommandSchema.safeParse({ ...metadata, operation, payload: {}, userId: 'caller-selected' }).success,
      ).toBe(false);
    },
  );
  it('keeps the private plan versioned, URL-safe and free of caller identifiers', () => {
    const plan = {
      kind: 'uid-password-reset-v1',
      recipient: 'Climber+tag@example.test',
      token: `pr1_${'A'.repeat(43)}`,
      expiresAt: '2026-11-05T12:00:00.000Z',
    };
    expect(passwordRecoveryMailPlanSchema.safeParse(plan).success).toBe(true);
    expect(passwordRecoveryMailPlanSchema.safeParse({ ...plan, identifier: 'password-reset:email' }).success).toBe(
      false,
    );
    expect(passwordRecoveryMailPlanSchema.safeParse({ ...plan, token: requestId }).success).toBe(false);
    expect(
      forgotPasswordReplySchema.safeParse({
        protocolVersion: 2,
        requestId,
        operation: 'forgot-password',
        outcome: 'accepted',
        mailPlan: plan,
      }).success,
    ).toBe(true);
  });
  it('reserves the whole namespace independently of strict current syntax', () => {
    for (const token of ['pr1_short', 'PR1_upper', 'pr2_future', 'pr999_']) {
      expect(isVersionedPasswordRecoveryToken(token)).toBe(true);
      expect(passwordRecoveryTokenSchema.safeParse(token).success).toBe(false);
    }
    expect(isVersionedPasswordRecoveryToken(requestId)).toBe(false);
    expect(passwordRecoveryTokenSchema.safeParse(`pr1_${'A'.repeat(43)}`).success).toBe(true);
  });
  it.each([
    ['reset', 200],
    ['invalid_or_expired', 200],
    ['legacy_unbound', 503],
  ] as const)('maps private %s to %i without public identity or credentials', (outcome, status) => {
    const reply = { protocolVersion: 2, operation: 'reset-password', requestId, outcome };
    expect(authCommandReplyStatus(resetPasswordReplySchema.parse(reply))).toBe(status);
    expect(resetPasswordReplySchema.safeParse({ ...reply, userId: 'private-owner' }).success).toBe(false);
    expect(resetPasswordReplySchema.safeParse({ ...reply, jwt: 'private-credential' }).success).toBe(false);
  });
});
