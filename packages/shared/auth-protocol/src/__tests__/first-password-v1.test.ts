import { describe, expect, it } from 'vite-plus/test';
import {
  firstPasswordCommandSchema,
  firstPasswordReplySchema,
  firstPasswordReplyStatus,
  firstPasswordMode,
  FIRST_PASSWORD_COMMAND_PATHS,
} from '../first-password-v1';
const metadata = {
  firstPasswordVersion: 1,
  requestId: '6df78119-74cc-4017-88c4-a42603e42618',
  issuedAt: '2026-11-14T17:00:00.000Z',
};
const actor = {
  presented: { kind: 'canonical-token', token: 'source-held-by-caller' },
  expectedUserId: 'fixed-uid',
  expectedAuthSessionId: 'fixed-sid',
};
const bound = { actor, challengeToken: 'c'.repeat(43) };
const candidate = { kind: 'canonical-token', credential: 'candidate-held-by-caller' };
describe('UID-bound first-password private v1 protocol', () => {
  it.each([
    ['request', { actor }],
    ['read', bound],
    [
      'prepare',
      { ...bound, confirmationToken: 'e'.repeat(43), password: ' new password ', confirmPassword: ' new password ' },
    ],
    ['finalize', { ...bound, preparationToken: 'f'.repeat(43) }],
    ['recover', { ...bound, preparationToken: 'f'.repeat(43), recoveryToken: 'g'.repeat(43) }],
  ])('pins explicit %s command without user/email lookup alternatives', (operation, payload) => {
    expect(firstPasswordCommandSchema.safeParse({ ...metadata, operation, payload }).success).toBe(true);
    expect(FIRST_PASSWORD_COMMAND_PATHS).toHaveProperty(String(operation));
    for (const extra of [
      { recipient: 'attacker@example.test' },
      { purpose: 'password-reset' },
      { emailBindingKey: 'caller-owned' },
      { userId: 'another-uid' },
    ])
      expect(
        firstPasswordCommandSchema.safeParse({ ...metadata, operation, payload: { ...payload, ...extra } }).success,
      ).toBe(false);
  });
  it('takes the web session, never a browser binding, a browser intent or a candidate credential', () => {
    const bindingActor = {
      kind: 'canonical-token',
      credential: 'source-held-by-caller',
      expectedUserId: 'fixed-uid',
      expectedAuthSessionId: 'fixed-sid',
      browserBindingToken: 'b'.repeat(43),
      browserVersion: 1,
    };
    expect(
      firstPasswordCommandSchema.safeParse({ ...metadata, operation: 'request', payload: { actor: bindingActor } })
        .success,
    ).toBe(false);
    expect(
      firstPasswordCommandSchema.safeParse({
        ...metadata,
        operation: 'read',
        payload: { ...bound, browserIntentToken: 'd'.repeat(43) },
      }).success,
    ).toBe(false);
    for (const operation of ['finalize', 'recover'] as const)
      expect(
        firstPasswordCommandSchema.safeParse({
          ...metadata,
          operation,
          payload: { ...bound, preparationToken: 'f'.repeat(43), recoveryToken: 'g'.repeat(43), candidate },
        }).success,
      ).toBe(false);
    expect(
      firstPasswordCommandSchema.safeParse({
        ...metadata,
        operation: 'request',
        payload: { actor: { ...actor, presented: { kind: 'legacy-jwe', credential: 'joined-nextauth-cookie' } } },
      }).success,
    ).toBe(true);
  });
  it('bounds the presented session before authority work', () => {
    const request = (presented: unknown) =>
      firstPasswordCommandSchema.safeParse({
        ...metadata,
        operation: 'request',
        payload: { actor: { ...actor, presented } },
      }).success;
    expect(request({ kind: 'canonical-token', token: 'a'.repeat(4096) })).toBe(true);
    expect(request({ kind: 'canonical-token', token: 'a'.repeat(4097) })).toBe(false);
    expect(request({ kind: 'legacy-jwe', credential: 'a'.repeat(12_288) })).toBe(true);
    expect(request({ kind: 'legacy-jwe', credential: 'a'.repeat(12_289) })).toBe(false);
  });
  it('recovery replies acknowledge only a caller-held hash, never a bearer', () => {
    const reply = {
      firstPasswordVersion: 1,
      requestId: metadata.requestId,
      operation: 'recover',
      outcome: 'recovered',
      generation: 2,
    };
    expect(firstPasswordReplySchema.safeParse(reply).success).toBe(true);
    for (const extra of [
      { candidate },
      { credential: candidate.credential },
      { confirmationToken: 'e'.repeat(43) },
      { mailPlan: { recipient: 'example@example.test' } },
      { browserCursor: { bindingId: 'b'.repeat(64), version: 2, bindingExpiresAt: metadata.issuedAt } },
    ])
      expect(firstPasswordReplySchema.safeParse({ ...reply, ...extra }).success).toBe(false);
    expect(firstPasswordReplySchema.safeParse({ ...reply, operation: 'finalize' }).success).toBe(false);
  });
  it.each([
    ['unauthenticated', 401],
    ['identity_changed', 409],
    ['canonical_session_required', 403],
    ['denied', 400],
    ['unavailable', 503],
  ] as const)('preserves exact %s refusal status', (outcome, status) => {
    const reply = firstPasswordReplySchema.parse({
      firstPasswordVersion: 1,
      requestId: metadata.requestId,
      operation: 'read',
      outcome,
      code:
        outcome === 'unavailable'
          ? 'authority_unavailable'
          : outcome === 'canonical_session_required'
            ? 'canonical_session_required'
            : 'invalid_proof',
    });
    expect(firstPasswordReplyStatus(reply)).toBe(status);
  });
  it('is dark by default and rejects unknown modes', () => {
    expect(firstPasswordMode({})).toBe('legacy');
    expect(firstPasswordMode({ CURRENT_STORE_FIRST_PASSWORD_MODE: 'legacy' })).toBe('legacy');
    expect(firstPasswordMode({ CURRENT_STORE_FIRST_PASSWORD_MODE: 'backend-staging' })).toBe('backend-staging');
    expect(() => firstPasswordMode({ CURRENT_STORE_FIRST_PASSWORD_MODE: 'on' })).toThrow();
  });
});
