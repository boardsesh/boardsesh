/**
 * Consent — first-render cookie + shared types.
 *
 * The cookie holds the user's analytics/error-monitoring decision so server
 * code (RSC, route handlers) can gate third-party scripts BEFORE hydration.
 * The richer copy of the decision (with `decidedAt`) is also written into
 * the user-preference IDB layer so it syncs across devices for signed-in
 * users via the generic preferences sync engine.
 *
 * Wire format for the cookie is intentionally compact and stable:
 *
 *   a=<0|1>&e=<0|1>&v=<policyVersion>
 *
 * Missing or malformed cookies parse to `unknown` decisions so callers must
 * always treat "no cookie yet" as a not-granted state.
 */

// RFC 6265 reserves `:` as a separator in cookie names; some intermediaries
// (and a strict reading of the spec) reject it. Use a hyphen to stay safe.
export const CONSENT_COOKIE = 'boardsesh-consent';
export const CONSENT_POLICY_VERSION = 1;

export type ConsentDecision = 'granted' | 'denied';

export type ConsentValue = {
  analytics: ConsentDecision | 'unknown';
  errorMonitoring: ConsentDecision | 'unknown';
  decidedAt: number | null;
  version: 1;
};

export const UNKNOWN_CONSENT: ConsentValue = {
  analytics: 'unknown',
  errorMonitoring: 'unknown',
  decidedAt: null,
  version: 1,
};

const decisionToFlag = (decision: ConsentDecision | 'unknown'): string | null => {
  if (decision === 'granted') return '1';
  if (decision === 'denied') return '0';
  return null;
};

const flagToDecision = (flag: string | undefined): ConsentDecision | 'unknown' => {
  if (flag === '1') return 'granted';
  if (flag === '0') return 'denied';
  return 'unknown';
};

/**
 * Serialize a {@link ConsentValue} into the compact cookie format
 * (`a=1&e=0&v=1`). Any field whose decision is `unknown` is omitted so
 * parsers can distinguish "never decided" from "decided as denied".
 *
 * Returned value is raw, NOT URI-encoded — every character used here is
 * a cookie-value-legal byte per RFC 6265 (digits, `=`, `&`, `v`, `a`, `e`).
 * The reader is symmetric: it does not decodeURIComponent. If the format
 * ever expands to include reserved characters, encode here AND decode in
 * `readBrowserCookie` — keep the two in lockstep.
 */
export function serializeConsentCookie(value: ConsentValue): string {
  const parts: string[] = [];
  const analyticsFlag = decisionToFlag(value.analytics);
  if (analyticsFlag !== null) {
    parts.push(`a=${analyticsFlag}`);
  }
  const errorFlag = decisionToFlag(value.errorMonitoring);
  if (errorFlag !== null) {
    parts.push(`e=${errorFlag}`);
  }
  parts.push(`v=${value.version}`);
  return parts.join('&');
}

/**
 * Parse the compact cookie format back into a {@link ConsentValue}. Returns
 * {@link UNKNOWN_CONSENT} for any malformed or empty input. `decidedAt` is
 * not stored on the cookie (it lives in IDB) so it always parses to `null`.
 */
export function parseConsentCookie(raw: string | null | undefined): ConsentValue {
  if (typeof raw !== 'string' || raw.length === 0) {
    return UNKNOWN_CONSENT;
  }

  const fields = new Map<string, string>();
  for (const segment of raw.split('&')) {
    const equalsIndex = segment.indexOf('=');
    if (equalsIndex === -1) continue;
    const fieldKey = segment.slice(0, equalsIndex);
    const fieldValue = segment.slice(equalsIndex + 1);
    if (fieldKey.length === 0) continue;
    fields.set(fieldKey, fieldValue);
  }

  const versionRaw = fields.get('v');
  if (versionRaw !== String(CONSENT_POLICY_VERSION)) {
    // Stale or future policy version — treat as undecided so the user is re-prompted.
    return UNKNOWN_CONSENT;
  }

  return {
    analytics: flagToDecision(fields.get('a')),
    errorMonitoring: flagToDecision(fields.get('e')),
    decidedAt: null,
    version: CONSENT_POLICY_VERSION,
  };
}

const readBrowserCookie = (cookieName: string): string | null => {
  if (typeof document === 'undefined') return null;
  // document.cookie is a flat "k=v; k2=v2" string per RFC 6265.
  // Read the raw value as-is — `serializeConsentCookie` writes a raw,
  // unencoded string today. If the wire format ever uses reserved
  // characters and the writer adds encodeURIComponent, decode here.
  const cookieJar = document.cookie;
  if (!cookieJar) return null;
  const prefix = `${cookieName}=`;
  for (const entry of cookieJar.split(';')) {
    const trimmed = entry.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return null;
};

/**
 * True when the user has explicitly granted analytics consent in the
 * client cookie. Returns false during SSR and when no cookie is set.
 */
export function hasAnalyticsConsent(): boolean {
  const cookie = readBrowserCookie(CONSENT_COOKIE);
  return parseConsentCookie(cookie).analytics === 'granted';
}

/**
 * True when the user has explicitly granted error-monitoring consent
 * in the client cookie. Returns false during SSR and when no cookie is set.
 */
export function hasErrorMonitoringConsent(): boolean {
  const cookie = readBrowserCookie(CONSENT_COOKIE);
  return parseConsentCookie(cookie).errorMonitoring === 'granted';
}
