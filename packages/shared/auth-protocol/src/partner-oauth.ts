/**
 * The partner OAuth issuer: the backend serves it on api.boardsesh.com, and
 * the www consent and sign-in pages send the browser back to its routes. The
 * one copy, so the two cannot drift.
 */
export const PARTNER_OAUTH_ISSUER = 'https://api.boardsesh.com/api/auth';

/** Hosted gym tools use their own audience; training-app credentials cannot use it. */
export const GYM_MCP_RESOURCE = 'https://api.boardsesh.com/mcp/gyms';
export const GYM_MCP_DEFAULT_SCOPES = ['gyms:read', 'gyms:write', 'gyms:access:write', 'offline_access'] as const;
/** Administrative repair requires a separate, explicit consent grant. */
export const GYM_MCP_ADMIN_SCOPES = ['gyms:admin:read', 'gyms:admin:write'] as const;
export const GYM_MCP_SCOPES = [...GYM_MCP_DEFAULT_SCOPES, ...GYM_MCP_ADMIN_SCOPES] as const;
export const GYM_MCP_MODES = ['off', 'pilot', 'on'] as const;
export type GymMcpMode = (typeof GYM_MCP_MODES)[number];

export function parseGymMcpMode(rawMode: string | undefined): GymMcpMode {
  const candidate = rawMode?.trim().toLowerCase();
  return GYM_MCP_MODES.find((mode) => mode === candidate) ?? 'off';
}

/**
 * The developer terms a registration accepts (www `/developers/terms`). The
 * console sends it with every new app and the backend refuses any other value,
 * then records it on the app's policy row with the time.
 *
 * Published 2026-11-17 (#6981 F18). Change it to the approval date whenever the
 * text changes: a new value makes the next registration accept the new text.
 */
export const PARTNER_DEVELOPER_TERMS_VERSION = '2026-11-17';

/**
 * Machine-readable `error` codes the consent routes answer with, beside a
 * readable `error_description`. The consent pages switch on these, never on
 * the text.
 */
export const PARTNER_CONSENT_ERRORS = {
  /** 401. No www session, or one whose sign-in cannot approve an app: sign in again. */
  loginRequired: 'login_required',
  /** 403. The request did not come from the Boardsesh website. */
  crossSite: 'invalid_request',
  /**
   * 400. This consent link cannot be answered any more: already answered,
   * expired, shown to another climber or another sign-in, or the climber
   * disconnected the app since. The app must start again.
   */
  linkSpent: 'link_spent',
  /** 403. The app is suspended or gone; nobody can connect it now. */
  appSuspended: 'app_suspended',
} as const;

export type PartnerConsentError = (typeof PARTNER_CONSENT_ERRORS)[keyof typeof PARTNER_CONSENT_ERRORS];

/**
 * The `extensions.reason` of a developer console change the backend refused
 * because the developer's sign-in is older than
 * `PARTNER_APP_CHANGE_SIGN_IN_MAX_AGE_SECONDS` (or its age is unknown). The
 * code is `FORBIDDEN`; the console switches on this reason, signs the developer
 * in again and brings them back to retry.
 */
export const PARTNER_CONSOLE_RECENT_SIGN_IN_REQUIRED = 'RECENT_SIGN_IN_REQUIRED';

/**
 * The PostHog flag that says who may use the developer console. www asks it
 * before it renders `/developers/apps`; the backend asks it again before every
 * console operation and refuses anyone it does not name (`NOT_ALLOWLISTED`).
 * One key for both, so the page and the operations cannot disagree on who is
 * invited. Evaluated for the account's `users.id`.
 */
export const PARTNER_DEVELOPER_CONSOLE_FLAG = 'developer-console';

/**
 * The `extensions.reason` of a console operation the backend could not check:
 * PostHog did not answer the `developer-console` question (down, slow, or the
 * flag missing). The code is `SERVICE_UNAVAILABLE`. The console says it could
 * not check the invite and offers a retry, rather than calling the developer
 * uninvited.
 */
export const PARTNER_CONSOLE_ALLOWLIST_UNAVAILABLE = 'ALLOWLIST_UNAVAILABLE';
