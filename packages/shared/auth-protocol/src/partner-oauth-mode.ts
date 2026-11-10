/**
 * `PARTNER_OAUTH_MODE`, read the same way by the backend (which serves the
 * partner OAuth routes) and the web (which guards OAuth account links only once
 * partner consent can exist). Each service reads its own environment, so a mode
 * change is set on both.
 */
export const PARTNER_OAUTH_MODES = ['off', 'hold', 'allowlist', 'open'] as const;

export type PartnerOAuthMode = (typeof PARTNER_OAUTH_MODES)[number];

/**
 * An absent, empty or unrecognised value is `off`, so a typo in a dashboard can
 * never switch partner OAuth on. Case and surrounding spaces are ignored.
 */
export function parsePartnerOAuthMode(rawMode: string | undefined): PartnerOAuthMode {
  const candidate = rawMode?.trim().toLowerCase();
  return PARTNER_OAUTH_MODES.find((mode) => mode === candidate) ?? 'off';
}
