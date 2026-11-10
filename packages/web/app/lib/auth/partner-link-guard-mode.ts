import { parsePartnerOAuthMode } from '@boardsesh/auth-protocol/partner-oauth-mode';

/**
 * Whether the web guards OAuth account links: while the web's own
 * `PARTNER_OAUTH_MODE` is not `off` (absent, empty and misspelled read as `off`,
 * the same parser the backend uses). Sign-ins made while it is on carry
 * `link_guarded`, which partner consent requires.
 */
export function partnerLinkGuardActive(environment: NodeJS.ProcessEnv = process.env): boolean {
  return parsePartnerOAuthMode(environment.PARTNER_OAUTH_MODE) !== 'off';
}
