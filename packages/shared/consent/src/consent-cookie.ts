import {
  isAnalyticsConsentChoice,
  isConsentSource,
  isRegionDefaultConsent,
  type ConsentRecord,
} from './consent-record';

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
 * Fifth cookie part that marks a region default (`basis: 'region_default'`).
 * An explicit answer has four parts, exactly as before the field existed.
 */
export const CONSENT_COOKIE_REGION_DEFAULT_PART = 'region';

/**
 * `v1.granted.1767225600.web`: version, choice, decision time in whole epoch
 * seconds, source. A region default adds a fifth part,
 * `v1.granted.1767225600.web.region`. Every character is URL-safe and
 * cookie-safe, so the value needs no encoding and the pre-paint script in the
 * web layout can read it with a plain string split. Bundles that predate the
 * fifth part read it as no answer and ask, which is the safe direction.
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
  const value = `v${record.version}.${record.analytics}.${decidedAtSeconds}.${record.source}`;
  return isRegionDefaultConsent(record) ? `${value}.${CONSENT_COOKIE_REGION_DEFAULT_PART}` : value;
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
  if (parts.length !== 4 && parts.length !== 5) return null;
  const [versionPart, choicePart, epochSecondsPart, sourcePart, basisPart] = parts;
  if (basisPart !== undefined && basisPart !== CONSENT_COOKIE_REGION_DEFAULT_PART) return null;

  const versionMatch = VERSION_PART.exec(versionPart);
  if (!versionMatch) return null;
  if (!isAnalyticsConsentChoice(choicePart)) return null;
  // A region default is only ever "on"; any other combination was not written by us.
  if (basisPart !== undefined && choicePart !== 'granted') return null;
  if (!EPOCH_SECONDS_PART.test(epochSecondsPart)) return null;
  if (!isConsentSource(sourcePart)) return null;

  const epochSeconds = Number(epochSecondsPart);
  if (epochSeconds > MAX_EPOCH_SECONDS) return null;
  const decidedAt = new Date(epochSeconds * 1000);

  const record: ConsentRecord = {
    analytics: choicePart,
    version: Number(versionMatch[1]),
    decidedAt: decidedAt.toISOString(),
    source: sourcePart,
  };
  return basisPart === undefined ? record : { ...record, basis: 'region_default' };
}
