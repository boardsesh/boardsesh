export const PARTNER_OAUTH_MODES = ['off', 'hold', 'allowlist', 'open'] as const;

export type PartnerOAuthMode = (typeof PARTNER_OAUTH_MODES)[number];

/**
 * `off` loads no Better Auth code. An absent or unrecognised value is `off`, so
 * a typo in a dashboard can never switch partner OAuth on.
 */
export function readPartnerOAuthMode(rawMode: string | undefined = process.env.PARTNER_OAUTH_MODE): PartnerOAuthMode {
  const candidate = rawMode?.trim().toLowerCase();
  return PARTNER_OAUTH_MODES.find((mode) => mode === candidate) ?? 'off';
}
