import { describe, expect, it } from 'vite-plus/test';

import {
  CONSENT_POLICY_VERSION,
  UNKNOWN_CONSENT,
  parseConsentCookie,
  serializeConsentCookie,
  type ConsentValue,
} from '../consent';

describe('consent cookie round-trip', () => {
  it('serializes and re-parses a fully granted decision', () => {
    const granted: ConsentValue = {
      analytics: 'granted',
      errorMonitoring: 'granted',
      decidedAt: 1_700_000_000_000,
      version: CONSENT_POLICY_VERSION,
    };
    const cookie = serializeConsentCookie(granted);
    expect(cookie).toBe(`a=1&e=1&v=${CONSENT_POLICY_VERSION}`);
    const parsed = parseConsentCookie(cookie);
    expect(parsed.analytics).toBe('granted');
    expect(parsed.errorMonitoring).toBe('granted');
    // decidedAt is not stored in the cookie — only the IDB copy carries it.
    expect(parsed.decidedAt).toBeNull();
    expect(parsed.version).toBe(CONSENT_POLICY_VERSION);
  });

  it('round-trips a denied decision', () => {
    const denied: ConsentValue = {
      analytics: 'denied',
      errorMonitoring: 'denied',
      decidedAt: 1_700_000_000_000,
      version: CONSENT_POLICY_VERSION,
    };
    const parsed = parseConsentCookie(serializeConsentCookie(denied));
    expect(parsed.analytics).toBe('denied');
    expect(parsed.errorMonitoring).toBe('denied');
  });

  it('round-trips a mixed decision', () => {
    const mixed: ConsentValue = {
      analytics: 'granted',
      errorMonitoring: 'denied',
      decidedAt: 1,
      version: CONSENT_POLICY_VERSION,
    };
    const parsed = parseConsentCookie(serializeConsentCookie(mixed));
    expect(parsed.analytics).toBe('granted');
    expect(parsed.errorMonitoring).toBe('denied');
  });

  it('omits unknown decisions from the wire format', () => {
    const partial: ConsentValue = {
      analytics: 'unknown',
      errorMonitoring: 'granted',
      decidedAt: null,
      version: CONSENT_POLICY_VERSION,
    };
    const cookie = serializeConsentCookie(partial);
    expect(cookie).toBe(`e=1&v=${CONSENT_POLICY_VERSION}`);
    const parsed = parseConsentCookie(cookie);
    expect(parsed.analytics).toBe('unknown');
    expect(parsed.errorMonitoring).toBe('granted');
  });
});

describe('consent cookie malformed inputs', () => {
  it('returns unknown for null', () => {
    expect(parseConsentCookie(null)).toEqual(UNKNOWN_CONSENT);
  });

  it('returns unknown for undefined', () => {
    expect(parseConsentCookie(undefined)).toEqual(UNKNOWN_CONSENT);
  });

  it('returns unknown for empty string', () => {
    expect(parseConsentCookie('')).toEqual(UNKNOWN_CONSENT);
  });

  it('returns unknown when version is missing', () => {
    expect(parseConsentCookie('a=1&e=1')).toEqual(UNKNOWN_CONSENT);
  });

  it('returns unknown when version is stale or unknown', () => {
    expect(parseConsentCookie('a=1&e=1&v=99')).toEqual(UNKNOWN_CONSENT);
  });

  it('returns unknown decisions for unrecognised flag values', () => {
    const parsed = parseConsentCookie(`a=yes&e=2&v=${CONSENT_POLICY_VERSION}`);
    expect(parsed.analytics).toBe('unknown');
    expect(parsed.errorMonitoring).toBe('unknown');
    expect(parsed.version).toBe(CONSENT_POLICY_VERSION);
  });

  it('ignores garbage segments without an equals sign', () => {
    const parsed = parseConsentCookie(`garbage&a=1&e=0&v=${CONSENT_POLICY_VERSION}`);
    expect(parsed.analytics).toBe('granted');
    expect(parsed.errorMonitoring).toBe('denied');
  });
});
