import { describe, expect, it } from 'vitest';
import {
  AUTH_PROTOCOL_VERSION,
  WEB_SESSION_LIFETIME_SECONDS,
  WEB_SESSION_ROLL_BELOW_REMAINING_SECONDS,
  WEB_SESSION_PROTOCOL_VERSION,
  passwordCommandSchema,
  passwordReplySchema,
  webSessionMode,
  webSessionReadCommandSchema,
  webSessionReadReplySchema,
  webSessionReplyStatus,
  webSessionRollReplySchema,
  webSessionSignOutCommandSchema,
} from '../index';

const requestId = '6f0c2a54-7d1e-4c3b-9a8f-1b2c3d4e5f60';

describe('web session protocol', () => {
  it('keeps the session numbers the owner chose', () => {
    expect(WEB_SESSION_LIFETIME_SECONDS).toBe(2_592_000);
    expect(WEB_SESSION_ROLL_BELOW_REMAINING_SECONDS).toBe(2_505_600);
  });

  it('reads the mode as off unless it is exactly backend-staging', () => {
    for (const mode of [undefined, '', 'legacy'])
      expect(webSessionMode({ CURRENT_STORE_WEB_SESSION_MODE: mode })).toBe('legacy');
    expect(webSessionMode({ CURRENT_STORE_WEB_SESSION_MODE: 'backend-staging' })).toBe('backend-staging');
    for (const mode of ['on', 'Backend-Staging', ' backend-staging'])
      expect(() => webSessionMode({ CURRENT_STORE_WEB_SESSION_MODE: mode })).toThrow();
  });

  it('lets a login ask for a session but never name its account', () => {
    const login = {
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation: 'password',
      requestId,
      issuedAt: 1,
      payload: { email: 'climber@example.test', password: 'secret' },
    };
    expect(passwordCommandSchema.safeParse(login).success).toBe(true);
    expect(
      passwordCommandSchema.safeParse({
        ...login,
        webSession: { presented: { kind: 'canonical-token', token: 'opaque' } },
      }).success,
    ).toBe(true);
    for (const webSession of [
      { userId: 'someone-else' },
      { presented: { kind: 'canonical-token', token: 'opaque', userId: 'someone-else' } },
      { presented: { kind: 'session-id', id: 'x' } },
    ])
      expect(passwordCommandSchema.safeParse({ ...login, webSession }).success).toBe(false);
  });

  it('returns the issued session only inside an authenticated reply', () => {
    const reply = {
      protocolVersion: AUTH_PROTOCOL_VERSION,
      operation: 'password',
      requestId,
      outcome: 'authenticated',
      webSession: { sessionId: 's', token: 't', expiresAt: new Date(0).toISOString(), generation: 0 },
      user: { id: 'u', email: 'climber@example.test', name: null, image: null },
      verification: { userId: 'u', required: false, verified: true },
    };
    expect(passwordReplySchema.safeParse(reply).success).toBe(true);
    expect(
      passwordReplySchema.safeParse({
        protocolVersion: AUTH_PROTOCOL_VERSION,
        operation: 'password',
        requestId,
        outcome: 'invalid_credentials',
        webSession: reply.webSession,
      }).success,
    ).toBe(false);
  });

  it('maps sign-out and roll outcomes to their statuses', () => {
    const base = { webSessionProtocolVersion: WEB_SESSION_PROTOCOL_VERSION, requestId } as const;
    expect(
      webSessionSignOutCommandSchema.safeParse({
        ...base,
        operation: 'signout',
        issuedAt: 1,
        payload: { token: 't', expectedUserId: 'u' },
      }).success,
    ).toBe(false);
    expect(webSessionReplyStatus({ ...base, operation: 'signout', outcome: 'signed_out' })).toBe(200);
    expect(webSessionReplyStatus({ ...base, operation: 'signout', outcome: 'identity_changed' })).toBe(409);
    expect(webSessionReplyStatus({ ...base, operation: 'roll', outcome: 'unauthenticated' })).toBe(401);
    expect(webSessionReplyStatus({ ...base, operation: 'roll', outcome: 'error', code: 'unavailable' })).toBe(503);
    expect(
      webSessionRollReplySchema.safeParse({
        ...base,
        operation: 'roll',
        outcome: 'active',
        userId: 'u',
        authSessionId: 's',
        expiresAt: new Date(0).toISOString(),
        rolled: true,
      }).success,
    ).toBe(true);
  });

  it('reads a session from either cookie and signs out from either form', () => {
    const base = { webSessionProtocolVersion: WEB_SESSION_PROTOCOL_VERSION, requestId } as const;
    const read = (presented: unknown) =>
      webSessionReadCommandSchema.safeParse({ ...base, operation: 'session', issuedAt: 1, payload: { presented } })
        .success;
    expect(read({ kind: 'canonical-token', token: 't' })).toBe(true);
    expect(read({ kind: 'legacy-jwe', credential: 'jwe' })).toBe(true);
    expect(read({ kind: 'canonical-token', token: 't', userId: 'u' })).toBe(false);
    expect(read(undefined)).toBe(false);

    const signOut = (payload: unknown) =>
      webSessionSignOutCommandSchema.safeParse({ ...base, operation: 'signout', issuedAt: 1, payload }).success;
    const expected = { expectedUserId: 'u', expectedAuthSessionId: 's' };
    expect(signOut({ token: 't', ...expected })).toBe(true);
    expect(signOut({ presented: { kind: 'legacy-jwe', credential: 'jwe' }, ...expected })).toBe(true);
    expect(signOut({ token: 't', presented: { kind: 'canonical-token', token: 't' }, ...expected })).toBe(false);
    expect(signOut({ presented: { kind: 'legacy-jwe', credential: 'jwe' }, expectedUserId: 'u' })).toBe(false);
  });

  it('answers a session read with the NextAuth user fields and nothing to write', () => {
    const base = { webSessionProtocolVersion: WEB_SESSION_PROTOCOL_VERSION, requestId } as const;
    const active = {
      ...base,
      operation: 'session',
      outcome: 'active',
      userId: 'u',
      authSessionId: 's',
      generation: 0,
      expiresAt: new Date(0).toISOString(),
      source: 'login',
      authenticatedAt: null,
      linkGuarded: false,
      user: { id: 'u', email: 'climber@example.test', name: null, image: null },
    } as const;
    expect(webSessionReadReplySchema.safeParse(active).success).toBe(true);
    expect(webSessionReadReplySchema.safeParse({ ...active, token: 't' }).success).toBe(false);
    expect(webSessionReadReplySchema.safeParse({ ...active, source: 'native' }).success).toBe(false);
    expect(webSessionReplyStatus(active)).toBe(200);
    expect(webSessionReplyStatus({ ...base, operation: 'session', outcome: 'unauthenticated' })).toBe(401);
  });
});
