import { isAnalyticsConsentChoice, isConsentSource, type ConsentRecord } from './consent-record';

/**
 * The web cookie that carries a device's answer. Set on `.boardsesh.com` so the
 * browser app at app.boardsesh.com reads the same answer as www.
 */
export const CONSENT_COOKIE_NAME = 'boardsesh-consent';

/** One year, the longest a consent answer is kept before it is asked again. */
export const CONSENT_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** Longest value {@link serializeConsentCookieValue} can produce, with room to spare. */
const MAX_COOKIE_VALUE_LENGTH = 64;

const VERSION_PART = /^v([1-9][0-9]{0,5})$/;
const EPOCH_SECONDS_PART = /^[0-9]{1,12}$/;
/**
 * 9999-12-31T23:59:59Z. Past it `toISOString()` switches to the six-digit
 * extended year format, and no honest cookie is dated that far out anyway.
 */
const MAX_EPOCH_SECONDS = 253_402_300_799;

/**
 * `v1.granted.1767225600.web`: version, choice, decision time in whole epoch
 * seconds, source. Every character is URL-safe and cookie-safe, so the value
 * needs no encoding and the pre-paint script in the web layout can read it with
 * a plain string split.
 *
 * Throws a RangeError when `decidedAt` is not a parseable date: a record this
 * code base produced always has one, so a bad date is a bug to surface, not a
 * value to paper over with "now".
 */
export function serializeConsentCookieValue(record: ConsentRecord): string {
  const decidedAtMs = Date.parse(record.decidedAt);
  if (!Number.isFinite(decidedAtMs) || decidedAtMs < 0) {
    throw new RangeError(`Consent record has an invalid decidedAt: ${record.decidedAt}`);
  }
  if (!Number.isInteger(record.version) || record.version < 1) {
    throw new RangeError(`Consent record has an invalid version: ${record.version}`);
  }
  const decidedAtSeconds = Math.floor(decidedAtMs / 1000);
  return `v${record.version}.${record.analytics}.${decidedAtSeconds}.${record.source}`;
}

/**
 * Read a cookie value back. Anything that is not exactly the shape
 * {@link serializeConsentCookieValue} writes returns null, which callers treat
 * as "no answer yet". A garbled or hand-edited cookie therefore re-asks; it can
 * never turn tracking on.
 *
 * Records under an old version parse fine; {@link resolveConsent} and
 * {@link needsPrompt} are where an old version stops counting.
 */
export function parseConsentCookieValue(raw: string | null | undefined): ConsentRecord | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_COOKIE_VALUE_LENGTH) return null;

  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const [versionPart, choicePart, epochSecondsPart, sourcePart] = parts;

  const versionMatch = VERSION_PART.exec(versionPart);
  if (!versionMatch) return null;
  if (!isAnalyticsConsentChoice(choicePart)) return null;
  if (!EPOCH_SECONDS_PART.test(epochSecondsPart)) return null;
  if (!isConsentSource(sourcePart)) return null;

  const epochSeconds = Number(epochSecondsPart);
  if (epochSeconds > MAX_EPOCH_SECONDS) return null;
  const decidedAt = new Date(epochSeconds * 1000);

  return {
    analytics: choicePart,
    version: Number(versionMatch[1]),
    decidedAt: decidedAt.toISOString(),
    source: sourcePart,
  };
}
