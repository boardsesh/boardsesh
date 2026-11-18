import { describe, expect, it } from 'vitest';
import { isNewerLegacyLogin } from '../legacy-login-precedence';
import { LEGACY_LOGIN_PRECEDENCE_VECTORS } from '../legacy-login-precedence-vectors';

describe('isNewerLegacyLogin', () => {
  it.each(LEGACY_LOGIN_PRECEDENCE_VECTORS.map((vector) => [vector.label, vector] as const))(
    '%s',
    (_label, { legacy, active, cookieKind, legacyWins }) => {
      expect(isNewerLegacyLogin(legacy, active, cookieKind)).toBe(legacyWins);
    },
  );

  it('takes a Date sign-in time as well as an ISO string', () => {
    const at = new Date('2026-11-18T10:00:00.000Z');
    const legacy = { authSessionId: 'b', authTime: at.getTime() / 1000 + 1, issuedAt: undefined };
    expect(isNewerLegacyLogin(legacy, { authSessionId: 'a', authenticatedAt: at }, 'login')).toBe(true);
  });
});
