import { describe, expect, it } from 'vite-plus/test';
import {
  BROWSER_BINDING_REQUEST_BYTES,
  BROWSER_BINDING_SOURCE_BYTES,
  browserBindingCommandSchema,
  browserBindingMode,
  browserBindingReplySchema,
  browserBindingReplyStatus,
  browserSourceCredentialSchema,
} from '../browser-binding-v1';

const metadata = {
  browserBindingProtocolVersion: 1,
  requestId: 'e363934b-b7ba-41ba-a279-52185daa100e',
};
const issuedAt = 1_794_573_000_000;
const bindingToken = 'a'.repeat(43);
const credential = { kind: 'legacy-jwe', credential: 'owned-client-held-proof' };
const actor = { version: 1, credential };
const cursor = { bindingId: 'b'.repeat(64), version: 1, bindingExpiresAt: '2026-11-14T10:00:00.000Z' };
const session = {
  userId: 'owned-user',
  authSessionId: 'owned-session',
  generation: 0,
  authenticatedAt: null,
  expiresAt: '2026-11-14T09:00:00.000Z',
  linkGuarded: false,
  requiresAccountCutoff: false,
};

describe('private browser binding protocol boundaries', () => {
  it.each([undefined, '', 'legacy'])('keeps an omitted or legacy mode disabled: %s', (mode) => {
    expect(browserBindingMode({ CURRENT_STORE_BROWSER_BINDING_MODE: mode })).toBe('legacy');
  });
  it('requires the exact explicit staging selector', () => {
    expect(browserBindingMode({ CURRENT_STORE_BROWSER_BINDING_MODE: 'backend-staging' })).toBe('backend-staging');
    expect(() => browserBindingMode({ CURRENT_STORE_BROWSER_BINDING_MODE: 'true' })).toThrow(
      'BROWSER_BINDING_MODE_INVALID',
    );
  });
  it('keeps correlation-only metadata distinct from actual admission', () => {
    expect(
      browserBindingCommandSchema.parse({ ...metadata, issuedAt, operation: 'describe', payload: { bindingToken } })
        .operation,
    ).toBe('describe');
    expect(
      browserBindingReplySchema.safeParse({
        ...metadata,
        operation: 'describe',
        outcome: 'known',
        cursor,
        state: 'selected',
        credentialKind: 'legacy-jwe',
        userId: 'owned-user',
      }).success,
    ).toBe(false);
    expect(
      browserBindingReplySchema.safeParse({
        ...metadata,
        operation: 'describe',
        outcome: 'known',
        cursor,
        state: 'selected',
        credentialKind: null,
      }).success,
    ).toBe(false);
  });
  it.each([
    { ...credential, secret: 'caller-selected-decryption-secret' },
    { ...credential, token: 'ambiguous-canonical-proof' },
    { kind: 'canonical-token', credential: 'wrong-source-kind-field' },
    { kind: 'canonical-token', token: 'owned-token', userId: 'caller-selected-user' },
  ])('rejects ambiguous credentials and caller identity or secret claims', (candidate) => {
    expect(browserSourceCredentialSchema.safeParse(candidate).success).toBe(false);
  });
  it('counts actual UTF8 bytes, including the exact source ceiling', () => {
    expect(
      browserSourceCredentialSchema.safeParse({ ...credential, credential: 'a'.repeat(BROWSER_BINDING_SOURCE_BYTES) })
        .success,
    ).toBe(true);
    expect(
      browserSourceCredentialSchema.safeParse({
        ...credential,
        credential: 'a'.repeat(BROWSER_BINDING_SOURCE_BYTES + 1),
      }).success,
    ).toBe(false);
    expect(
      browserSourceCredentialSchema.safeParse({
        ...credential,
        credential: '🧗'.repeat(BROWSER_BINDING_SOURCE_BYTES / 4),
      }).success,
    ).toBe(true);
    expect(
      browserSourceCredentialSchema.safeParse({
        ...credential,
        credential: '🧗'.repeat(BROWSER_BINDING_SOURCE_BYTES / 4 + 1),
      }).success,
    ).toBe(false);
  });
  it('fits two maximal actual ASCII proofs in the selected overall request budget', () => {
    const source = { kind: 'legacy-jwe', credential: 'a'.repeat(BROWSER_BINDING_SOURCE_BYTES) };
    const command = {
      ...metadata,
      issuedAt,
      operation: 'login',
      payload: {
        bindingToken,
        intentToken: bindingToken,
        actor: { version: 1, credential: source },
        candidate: source,
      },
    };
    expect(browserBindingCommandSchema.safeParse(command).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(command)).byteLength).toBeLessThan(BROWSER_BINDING_REQUEST_BYTES);
  });
  it('never accepts a caller-selected bootstrap expiry or an actor without raw possession', () => {
    expect(
      browserBindingCommandSchema.safeParse({
        ...metadata,
        issuedAt,
        operation: 'bootstrap',
        payload: { expiresAt: cursor.bindingExpiresAt },
      }).success,
    ).toBe(false);
    expect(
      browserBindingCommandSchema.safeParse({
        ...metadata,
        issuedAt,
        operation: 'read',
        payload: { bindingToken, actor: { version: 1 } },
      }).success,
    ).toBe(false);
  });
  it('requires original actor possession for logout and candidate possession for login', () => {
    expect(
      browserBindingCommandSchema.safeParse({
        ...metadata,
        issuedAt,
        operation: 'logout',
        payload: { bindingToken, intentToken: bindingToken },
      }).success,
    ).toBe(false);
    expect(
      browserBindingCommandSchema.safeParse({
        ...metadata,
        issuedAt,
        operation: 'login',
        payload: { bindingToken, intentToken: bindingToken, actor },
      }).success,
    ).toBe(false);
  });
  it('binds admitted profile identity to the actual session and excludes raw source material', () => {
    const admitted = {
      ...metadata,
      operation: 'read',
      outcome: 'admitted',
      cursor,
      session,
      user: { id: session.userId, email: 'owned@example.test', name: null, image: null },
    };
    expect(browserBindingReplySchema.safeParse(admitted).success).toBe(true);
    expect(
      browserBindingReplySchema.safeParse({ ...admitted, user: { ...admitted.user, id: 'foreign-user' } }).success,
    ).toBe(false);
    expect(browserBindingReplySchema.safeParse({ ...admitted, credential }).success).toBe(false);
  });
  it('requires a selected session after login and an anonymous selection after logout', () => {
    for (const outcome of ['committed', 'already-committed']) {
      expect(
        browserBindingReplySchema.safeParse({ ...metadata, operation: 'login', outcome, cursor, session }).success,
      ).toBe(true);
      expect(
        browserBindingReplySchema.safeParse({ ...metadata, operation: 'logout', outcome, cursor, session: null })
          .success,
      ).toBe(true);
      expect(
        browserBindingReplySchema.safeParse({ ...metadata, operation: 'login', outcome, cursor, session: null })
          .success,
      ).toBe(false);
      expect(
        browserBindingReplySchema.safeParse({ ...metadata, operation: 'logout', outcome, cursor, session }).success,
      ).toBe(false);
    }
  });
  it.each([
    ['denied', 401],
    ['conflict', 409],
    ['unavailable', 503],
  ] as const)('maps %s without exposing nested error detail', (outcome, expectedStatus) => {
    const reply = browserBindingReplySchema.parse({ ...metadata, operation: 'read', outcome });
    expect(browserBindingReplyStatus(reply)).toBe(expectedStatus);
    expect(browserBindingReplySchema.safeParse({ ...reply, cause: 'private-database-details' }).success).toBe(false);
  });
});
