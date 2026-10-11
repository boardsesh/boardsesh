/**
 * The analytics consent model shared by web, mobile and the backend.
 *
 * One record says whether a climber allowed product analytics (PostHog capture,
 * session replay, install attribution) and when. Self-hosted Observe and Sentry
 * run under legitimate interest and do not read it. It lives in two places: on
 * the device (a cookie on web, local storage in the app) and on the account
 * (`user_analytics_consent_events`, newest row wins). The two are merged by
 * {@link resolveConsent}. See `docs/analytics-consent.md`.
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

/**
 * Why a device holds its answer. `explicit` (or no `basis` at all, which is
 * every record written before this field existed and every account answer) is
 * a choice the climber made. `region_default` is the "on" a device outside the
 * prompt regions starts with when it has no answer: it is never written to an
 * account, never counts as an Art. 7 consent, and an account denial still
 * overrides it. Adding the field needed no CONSENT_VERSION bump: records
 * without it read as explicit, exactly as before.
 */
export const CONSENT_BASES = ['explicit', 'region_default'] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

export type ConsentRecord = {
  analytics: AnalyticsConsentChoice;
  version: number;
  /** ISO 8601. The server stamps its own clock on the account copy. */
  decidedAt: string;
  source: ConsentSource;
  /** Absent means explicit. Device-only: the account copy never carries it. */
  basis?: ConsentBasis;
};

/**
 * The device's copy of an answer. See `createConsentSyncCoordinator`.
 *
 * A region default (`basis: 'region_default'`) never carries `ownerAccountId`
 * or `basedOnDecidedAt`: it is nobody's answer and is never written anywhere.
 *
 * - `ownerAccountId` is the account that was signed in when this device made
 *   the answer or adopted it from the account. Null or missing means it was
 *   made signed out (or predates this field, or came from the shared web
 *   cookie, which never carries an account): a device-only answer that is
 *   never written to any account.
 * - `basedOnDecidedAt` is present only on a decision this device made signed in
 *   that the account has not confirmed yet: the account `decidedAt` it was made
 *   against (null when the account had no answer). A copy adopted from the
 *   account never has it, so an adopted copy is never written back.
 */
export type DeviceConsentRecord = ConsentRecord & {
  ownerAccountId?: string | null;
  basedOnDecidedAt?: string | null;
};

/** True when this device answer was made or adopted while `accountId` was signed in. */
export function isConsentRecordOwnedBy(record: DeviceConsentRecord | null, accountId: string | null): boolean {
  return (
    accountId !== null &&
    record !== null &&
    typeof record.ownerAccountId === 'string' &&
    record.ownerAccountId === accountId
  );
}

/**
 * Field-by-field equality, including `ownerAccountId` (missing equals null),
 * `basedOnDecidedAt` (missing differs from null: confirmed vs made against no
 * answer) and `basis` (missing equals `explicit`). Key order and extra wire
 * fields (`__typename`) do not matter.
 */
export function isSameConsentRecord(left: DeviceConsentRecord | null, right: DeviceConsentRecord | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.analytics === right.analytics &&
    left.version === right.version &&
    left.decidedAt === right.decidedAt &&
    left.source === right.source &&
    (left.ownerAccountId ?? null) === (right.ownerAccountId ?? null) &&
    left.basedOnDecidedAt === right.basedOnDecidedAt &&
    (left.basis ?? 'explicit') === (right.basis ?? 'explicit')
  );
}

export function isAnalyticsConsentChoice(candidate: unknown): candidate is AnalyticsConsentChoice {
  return candidate === 'granted' || candidate === 'denied';
}

export function isConsentSource(candidate: unknown): candidate is ConsentSource {
  return candidate === 'web' || candidate === 'ios' || candidate === 'android';
}

export function isConsentBasis(candidate: unknown): candidate is ConsentBasis {
  return candidate === 'explicit' || candidate === 'region_default';
}

/** True for the device-local default a device outside the prompt regions starts with. */
export function isRegionDefaultConsent(record: ConsentRecord | null): boolean {
  return record !== null && record.basis === 'region_default';
}

/**
 * The answer a device with no answer of its own takes when its region does not
 * need the prompt (`consentPromptRequired` is false): analytics on, marked as a
 * region default so it stays on this device. A later choice in Settings
 * replaces it with an explicit record.
 */
export function createRegionDefaultConsent(source: ConsentSource, now: Date = new Date()): ConsentRecord {
  return {
    analytics: 'granted',
    version: CONSENT_VERSION,
    decidedAt: now.toISOString(),
    source,
    basis: 'region_default',
  };
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
 *    answer of its own, or only a region default. A device that said no keeps
 *    saying no.
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
  if (currentServer?.analytics === 'granted' && (currentLocal === null || isRegionDefaultConsent(currentLocal)))
    return currentServer;
  return currentLocal;
}

/** True when this device has no current answer and has to ask. */
export function needsPrompt(record: ConsentRecord | null): boolean {
  return !isCurrentConsentRecord(record);
}

/**
 * True only for a current "Allow", or the region default outside the prompt
 * regions. No answer means no tracking.
 */
export function isAnalyticsGranted(record: ConsentRecord | null): boolean {
  return isCurrentConsentRecord(record) && record.analytics === 'granted';
}
