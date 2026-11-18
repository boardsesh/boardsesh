import { describe, expect, it } from 'vitest';
import { isNewerLegacyLogin, type FirstPartyLogin, type LegacyLoginClaims } from '../legacy-login-precedence';

const SIGNED_IN_AT = '2026-11-18T10:00:00.000Z';
const SIGNED_IN_SECONDS = Date.parse(SIGNED_IN_AT) / 1000;
const active: FirstPartyLogin = { authSessionId: 'session-a', authenticatedAt: SIGNED_IN_AT };

/**
 * The vectors www's copy in #7789 (`newerLegacyLogin`) must agree with. Each is
 * [label, legacy claims, active login, legacy wins].
 */
const LEGACY_LOGIN_PRECEDENCE_VECTORS: ReadonlyArray<readonly [string, LegacyLoginClaims, FirstPartyLogin, boolean]> = [
  [
    'a later sign-in under another session id',
    { authSessionId: 'session-b', authTime: SIGNED_IN_SECONDS + 1, issuedAt: SIGNED_IN_SECONDS + 5 },
    active,
    true,
  ],
  [
    'a later sign-in with no session id',
    { authSessionId: undefined, authTime: SIGNED_IN_SECONDS + 60, issuedAt: SIGNED_IN_SECONDS + 60 },
    active,
    true,
  ],
  [
    'the same session id, however late',
    { authSessionId: 'session-a', authTime: SIGNED_IN_SECONDS + 600, issuedAt: SIGNED_IN_SECONDS + 600 },
    active,
    false,
  ],
  [
    'the same second',
    { authSessionId: 'session-b', authTime: SIGNED_IN_SECONDS, issuedAt: SIGNED_IN_SECONDS + 9 },
    active,
    false,
  ],
  [
    'an earlier sign-in',
    { authSessionId: 'session-b', authTime: SIGNED_IN_SECONDS - 1, issuedAt: SIGNED_IN_SECONDS + 9 },
    active,
    false,
  ],
  [
    'no auth_time, a later issue time',
    { authSessionId: 'session-b', authTime: undefined, issuedAt: SIGNED_IN_SECONDS + 9 },
    active,
    true,
  ],
  [
    'no auth_time, an earlier issue time',
    { authSessionId: 'session-b', authTime: undefined, issuedAt: SIGNED_IN_SECONDS - 9 },
    active,
    false,
  ],
  ['no times at all', { authSessionId: 'session-b', authTime: undefined, issuedAt: undefined }, active, false],
  [
    'a string auth_time falls back to iat',
    { authSessionId: 'session-b', authTime: `${SIGNED_IN_SECONDS + 600}`, issuedAt: SIGNED_IN_SECONDS - 9 },
    active,
    false,
  ],
  [
    'an unknown session sign-in time',
    { authSessionId: 'session-b', authTime: SIGNED_IN_SECONDS + 600, issuedAt: SIGNED_IN_SECONDS + 600 },
    { authSessionId: 'session-a', authenticatedAt: null },
    false,
  ],
  [
    'a Date sign-in time',
    { authSessionId: 'session-b', authTime: SIGNED_IN_SECONDS + 1, issuedAt: SIGNED_IN_SECONDS + 1 },
    { authSessionId: 'session-a', authenticatedAt: new Date(SIGNED_IN_AT) },
    true,
  ],
];

describe('isNewerLegacyLogin', () => {
  it.each(LEGACY_LOGIN_PRECEDENCE_VECTORS)('%s', (_label, legacy, login, legacyWins) => {
    expect(isNewerLegacyLogin(legacy, login)).toBe(legacyWins);
  });
});
