import type { FirstPartyCookieKind, FirstPartyLogin, LegacyLoginClaims } from './legacy-login-precedence';

/**
 * Shared test vectors for `isNewerLegacyLogin` (#7596). www and the backend
 * both run them, so the two readers of a browser's cookies cannot drift.
 * Each: a label, the legacy cookie's claims, the first-party session, the
 * first-party cookie's kind, and whether the legacy cookie wins.
 */
export interface LegacyLoginPrecedenceVector {
  readonly label: string;
  readonly legacy: LegacyLoginClaims;
  readonly active: FirstPartyLogin;
  readonly cookieKind: FirstPartyCookieKind;
  readonly legacyWins: boolean;
}

const SIGNED_IN_AT = '2026-11-18T10:00:00.000Z';
const SIGNED_IN_SECONDS = Date.parse(SIGNED_IN_AT) / 1000;
const known: FirstPartyLogin = { authSessionId: 'session-a', authenticatedAt: SIGNED_IN_AT };
const unknown: FirstPartyLogin = { authSessionId: 'session-a', authenticatedAt: null };
const claims = (authSessionId: unknown, authTime: unknown, issuedAt: unknown): LegacyLoginClaims => ({
  authSessionId,
  authTime,
  issuedAt,
});

export const LEGACY_LOGIN_PRECEDENCE_VECTORS: readonly LegacyLoginPrecedenceVector[] = Object.freeze([
  // Beside a login cookie.
  {
    label: 'login: a later sign-in, another id',
    legacy: claims('session-b', SIGNED_IN_SECONDS + 1, SIGNED_IN_SECONDS + 5),
    active: known,
    cookieKind: 'login',
    legacyWins: true,
  },
  {
    label: 'login: a later sign-in, no id',
    legacy: claims(undefined, SIGNED_IN_SECONDS + 60, SIGNED_IN_SECONDS + 60),
    active: known,
    cookieKind: 'login',
    legacyWins: true,
  },
  {
    label: 'login: the same id, however late',
    legacy: claims('session-a', SIGNED_IN_SECONDS + 600, SIGNED_IN_SECONDS + 600),
    active: known,
    cookieKind: 'login',
    legacyWins: false,
  },
  {
    label: 'login: the same second',
    legacy: claims('session-b', SIGNED_IN_SECONDS, SIGNED_IN_SECONDS + 9),
    active: known,
    cookieKind: 'login',
    legacyWins: false,
  },
  {
    label: 'login: an earlier sign-in',
    legacy: claims('session-b', SIGNED_IN_SECONDS - 1, SIGNED_IN_SECONDS + 9),
    active: known,
    cookieKind: 'login',
    legacyWins: false,
  },
  {
    label: 'login: no auth_time, a later iat',
    legacy: claims('session-b', undefined, SIGNED_IN_SECONDS + 9),
    active: known,
    cookieKind: 'login',
    legacyWins: true,
  },
  {
    label: 'login: no auth_time, an earlier iat',
    legacy: claims('session-b', undefined, SIGNED_IN_SECONDS - 9),
    active: known,
    cookieKind: 'login',
    legacyWins: false,
  },
  {
    label: 'login: no times at all',
    legacy: claims('session-b', undefined, undefined),
    active: known,
    cookieKind: 'login',
    legacyWins: false,
  },
  {
    label: 'login: a string auth_time falls back to iat',
    legacy: claims('session-b', `${SIGNED_IN_SECONDS + 600}`, SIGNED_IN_SECONDS - 9),
    active: known,
    cookieKind: 'login',
    legacyWins: false,
  },
  {
    label: 'login: an unknown session sign-in time',
    legacy: claims('session-b', SIGNED_IN_SECONDS + 600, SIGNED_IN_SECONDS + 600),
    active: unknown,
    cookieKind: 'login',
    legacyWins: false,
  },
  // Beside a bridged cookie: the id alone decides.
  {
    label: 'bridged: another id, an earlier sign-in',
    legacy: claims('session-b', SIGNED_IN_SECONDS - 600, SIGNED_IN_SECONDS - 600),
    active: known,
    cookieKind: 'bridged',
    legacyWins: true,
  },
  {
    label: 'bridged: another id, an unknown session time',
    legacy: claims('session-b', undefined, SIGNED_IN_SECONDS - 600),
    active: unknown,
    cookieKind: 'bridged',
    legacyWins: true,
  },
  {
    label: 'bridged: the same id',
    legacy: claims('session-a', SIGNED_IN_SECONDS + 600, SIGNED_IN_SECONDS + 600),
    active: unknown,
    cookieKind: 'bridged',
    legacyWins: false,
  },
  {
    label: 'bridged: no id claim, however late',
    legacy: claims(undefined, SIGNED_IN_SECONDS + 600, SIGNED_IN_SECONDS + 600),
    active: known,
    cookieKind: 'bridged',
    legacyWins: false,
  },
  {
    label: 'bridged: a non-string id claim',
    legacy: claims(42, SIGNED_IN_SECONDS + 600, SIGNED_IN_SECONDS + 600),
    active: known,
    cookieKind: 'bridged',
    legacyWins: false,
  },
]);
