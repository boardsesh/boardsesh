// @vitest-environment node
import { describe, expect, it, vi } from 'vite-plus/test';
import { LEGACY_LOGIN_PRECEDENCE_VECTORS } from '@boardsesh/auth-protocol/legacy-login-precedence-vectors';
vi.mock('server-only', () => ({}));
import { legacyClaimsWin } from '../browser-session-bridge.server';

/**
 * The backend's partner consent (B6) and www's session read and ws-auth (B2b,
 * B3b) decide "is the legacy cookie a newer login" by one shared rule. These
 * are the shared vectors, run through www's mapping of NextAuth claim names.
 */
describe('www applies the shared legacy-login precedence vectors', () => {
  it.each(LEGACY_LOGIN_PRECEDENCE_VECTORS.map((vector) => [vector.label, vector] as const))(
    '%s',
    (_label, { legacy, active, cookieKind, legacyWins }) => {
      const claims = { authSessionId: legacy.authSessionId, auth_time: legacy.authTime, iat: legacy.issuedAt };
      const authenticatedAt =
        active.authenticatedAt instanceof Date ? active.authenticatedAt.toISOString() : active.authenticatedAt;
      expect(legacyClaimsWin(claims, { authSessionId: active.authSessionId, authenticatedAt }, cookieKind)).toBe(
        legacyWins,
      );
    },
  );
});
