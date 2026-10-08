/**
 * The analytics consent model shared by web, mobile and the backend.
 *
 * One record says whether a climber allowed product analytics (PostHog capture,
 * session replay, EAS Observe, install attribution) and when. It lives in two
 * places: on the device (a cookie on web, local storage in the app) and on the
 * account (`user_analytics_consent_events`, newest row wins). The two are merged
 * by {@link resolveConsent}. See `docs/analytics-consent.md`.
 */

/**
 * Bump this to ask everyone again. A record written under an older version is
 * treated as no answer at all, so the prompt comes back on every device.
 */
export const CONSENT_VERSION = 1;

export const ANALYTICS_CONSENT_CHOICES = ['granted', 'denied'] as const;
export type AnalyticsConsentChoice = (typeof ANALYTICS_CONSENT_CHOICES)[number];

/** Where the answer was given. The server never trusts this for anything but display and audit. */
export const CONSENT_SOURCES = ['web', 'ios', 'android'] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export type ConsentRecord = {
  analytics: AnalyticsConsentChoice;
  version: number;
  /** ISO 8601. The server stamps its own clock on the account copy. */
  decidedAt: string;
  source: ConsentSource;
};

export function isAnalyticsConsentChoice(candidate: unknown): candidate is AnalyticsConsentChoice {
  return candidate === 'granted' || candidate === 'denied';
}

export function isConsentSource(candidate: unknown): candidate is ConsentSource {
  return candidate === 'web' || candidate === 'ios' || candidate === 'android';
}

/**
 * True when the record was written under the current {@link CONSENT_VERSION}
 * (or a newer one, which an older bundle must not re-ask over).
 */
export function isCurrentConsentRecord(record: ConsentRecord | null): record is ConsentRecord {
  return record !== null && record.version >= CONSENT_VERSION;
}

/**
 * Merge the device's answer with the account's.
 *
 * 1. Records older than {@link CONSENT_VERSION} count as no answer.
 * 2. An account `denied` always wins. Saying no anywhere you are signed in stops
 *    tracking everywhere you are signed in.
 * 3. An account `granted` only fills a gap: it applies to a device that has no
 *    answer of its own. A device that said no keeps saying no.
 * 4. Otherwise the device's own answer stands (including no answer, `null`).
 *
 * Because rule 2 lets the account override a newer device grant, a client must
 * push a fresh decision with `setAnalyticsConsent` BEFORE it next resolves
 * against the server. Otherwise a climber who changes "No thanks" to "Allow"
 * on one device would have the old account denial flip it straight back.
 */
export function resolveConsent(local: ConsentRecord | null, server: ConsentRecord | null): ConsentRecord | null {
  const currentLocal = isCurrentConsentRecord(local) ? local : null;
  const currentServer = isCurrentConsentRecord(server) ? server : null;

  if (currentServer?.analytics === 'denied') return currentServer;
  if (currentServer?.analytics === 'granted' && currentLocal === null) return currentServer;
  return currentLocal;
}

/** True when this device has no current answer and has to ask. */
export function needsPrompt(record: ConsentRecord | null): boolean {
  return !isCurrentConsentRecord(record);
}

/** True only for a current, explicit "Allow". No answer means no tracking. */
export function isAnalyticsGranted(record: ConsentRecord | null): boolean {
  return isCurrentConsentRecord(record) && record.analytics === 'granted';
}
