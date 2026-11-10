/**
 * The partner OAuth issuer: the backend serves it on api.boardsesh.com, and
 * the www consent and sign-in pages send the browser back to its routes. The
 * one copy, so the two cannot drift.
 */
export const PARTNER_OAUTH_ISSUER = 'https://api.boardsesh.com/api/auth';

/**
 * The developer terms a registration accepts (www `/developers/terms`). The
 * console sends it with every new app and the backend refuses any other value,
 * then records it on the app's policy row with the time.
 *
 * DRAFT (#6981 F18): the terms are a draft until the owner approves them. On
 * approval, set the approval date here, and change it again whenever the text
 * changes: a new value makes the next registration accept the new text.
 */
export const PARTNER_DEVELOPER_TERMS_VERSION = '2026-11-10-draft';

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
