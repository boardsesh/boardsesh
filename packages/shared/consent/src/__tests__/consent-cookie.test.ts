import { describe, expect, it } from 'vitest';

import {
  CONSENT_COOKIE_MAX_AGE_SECONDS,
  CONSENT_COOKIE_NAME,
  CONSENT_VERSION,
  parseConsentCookieValue,
  serializeConsentCookieValue,
  type ConsentRecord,
} from '../index';

const grantedOnWeb: ConsentRecord = {
  analytics: 'granted',
  version: CONSENT_VERSION,
  decidedAt: '2026-01-01T00:00:00.000Z',
  source: 'web',
};

describe('consent cookie constants', () => {
  it('names the cookie and keeps it for a year', () => {
    expect(CONSENT_COOKIE_NAME).toBe('boardsesh-consent');
    expect(CONSENT_COOKIE_MAX_AGE_SECONDS).toBe(31_536_000);
  });
});

describe('serializeConsentCookieValue', () => {
  it('writes version, choice, epoch seconds and source', () => {
    expect(serializeConsentCookieValue(grantedOnWeb)).toBe('v1.granted.1767225600.web');
  });

  it('drops sub-second precision', () => {
    const value = serializeConsentCookieValue({ ...grantedOnWeb, decidedAt: '2026-01-01T00:00:00.999Z' });
    expect(value).toBe('v1.granted.1767225600.web');
  });

  it('only uses URL- and cookie-safe characters', () => {
    const value = serializeConsentCookieValue({ ...grantedOnWeb, analytics: 'denied', source: 'android' });
    expect(value).toMatch(/^[a-z0-9.]+$/);
    expect(encodeURIComponent(value)).toBe(value);
  });

  it('refuses an unparseable date instead of inventing one', () => {
    expect(() => serializeConsentCookieValue({ ...grantedOnWeb, decidedAt: 'yesterday' })).toThrow(RangeError);
  });

  it('refuses a version that is not a positive integer', () => {
    expect(() => serializeConsentCookieValue({ ...grantedOnWeb, version: 0 })).toThrow(RangeError);
    expect(() => serializeConsentCookieValue({ ...grantedOnWeb, version: 1.5 })).toThrow(RangeError);
  });
});

describe('parseConsentCookieValue', () => {
  it('round-trips every choice and source', () => {
    for (const analytics of ['granted', 'denied'] as const) {
      for (const source of ['web', 'ios', 'android'] as const) {
        const record: ConsentRecord = { ...grantedOnWeb, analytics, source };
        expect(parseConsentCookieValue(serializeConsentCookieValue(record))).toEqual(record);
      }
    }
  });

  it('keeps an older version so the merge rule can ignore it', () => {
    expect(parseConsentCookieValue('v1.denied.1767225600.ios')).toEqual({
      analytics: 'denied',
      version: 1,
      decidedAt: '2026-01-01T00:00:00.000Z',
      source: 'ios',
    });
    expect(parseConsentCookieValue('v7.granted.0.web')?.version).toBe(7);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseConsentCookieValue('  v1.granted.1767225600.web ')?.analytics).toBe('granted');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['too few parts', 'v1.granted.1767225600'],
    ['too many parts', 'v1.granted.1767225600.web.extra'],
    ['missing v prefix', '1.granted.1767225600.web'],
    ['zero version', 'v0.granted.1767225600.web'],
    ['leading-zero version', 'v01.granted.1767225600.web'],
    ['negative version', 'v-1.granted.1767225600.web'],
    ['unknown choice', 'v1.maybe.1767225600.web'],
    ['upper-case choice', 'v1.GRANTED.1767225600.web'],
    ['non-numeric time', 'v1.granted.soon.web'],
    ['negative time', 'v1.granted.-5.web'],
    ['fractional time', 'v1.granted.1767225600.5.web'],
    ['unknown source', 'v1.granted.1767225600.desktop'],
    ['JSON', '{"analytics":"granted"}'],
    ['legacy boolean', 'true'],
    ['overlong', `v1.granted.1767225600.web${'x'.repeat(80)}`],
    ['encoded garbage', 'v1%2Egranted%2E1767225600%2Eweb'],
  ])('rejects %s', (_label, raw) => {
    expect(parseConsentCookieValue(raw)).toBeNull();
  });

  it('rejects a timestamp past the year 9999', () => {
    expect(parseConsentCookieValue('v1.granted.999999999999.web')).toBeNull();
    expect(parseConsentCookieValue('v1.granted.253402300799.web')?.decidedAt).toBe('9999-12-31T23:59:59.000Z');
  });
});
