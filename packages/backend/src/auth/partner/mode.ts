import { parsePartnerOAuthMode, type PartnerOAuthMode } from '@boardsesh/auth-protocol/partner-oauth-mode';

export { PARTNER_OAUTH_MODES, type PartnerOAuthMode } from '@boardsesh/auth-protocol/partner-oauth-mode';

/**
 * `off` loads no Better Auth code. An absent or unrecognised value is `off`, so
 * a typo in a dashboard can never switch partner OAuth on.
 */
export function readPartnerOAuthMode(rawMode: string | undefined = process.env.PARTNER_OAUTH_MODE): PartnerOAuthMode {
  return parsePartnerOAuthMode(rawMode);
}
