/**
 * Google's authorization parameters for a forced, fresh sign-in (#7590,
 * #7655): `prompt=login` is not a value Google accepts. With `max_age=0` the
 * ID token's `auth_time` is the sign-in just made; the backend still decides
 * freshness from that signed `auth_time`, never from what www asked for.
 * Shared by the provider-security reauthentication round trip and the forced
 * re-sign-in page's Google button.
 */
export const GOOGLE_FORCED_REAUTHENTICATION: Readonly<Record<'max_age' | 'prompt', string>> = Object.freeze({
  max_age: '0',
  prompt: 'select_account consent',
});
