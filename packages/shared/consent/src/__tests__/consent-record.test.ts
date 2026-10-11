import { describe, expect, it } from 'vitest';

import {
  CONSENT_VERSION,
  isAnalyticsConsentChoice,
  isAnalyticsGranted,
  isConsentRecordOwnedBy,
  isConsentSource,
  isCurrentConsentRecord,
  isSameConsentRecord,
  needsPrompt,
  resolveConsent,
  type ConsentRecord,
} from '../index';

function consentRecord(overrides: Partial<ConsentRecord> = {}): ConsentRecord {
  return {
    analytics: 'granted',
    version: CONSENT_VERSION,
    decidedAt: '2026-10-01T12:00:00.000Z',
    source: 'web',
    ...overrides,
  };
}

const localGrant = consentRecord({ analytics: 'granted', source: 'ios' });
const localDenial = consentRecord({ analytics: 'denied', source: 'ios' });
const serverGrant = consentRecord({ analytics: 'granted', source: 'web', decidedAt: '2026-10-02T08:00:00.000Z' });
const serverDenial = consentRecord({ analytics: 'denied', source: 'web', decidedAt: '2026-10-02T08:00:00.000Z' });
const staleLocalGrant = consentRecord({ analytics: 'granted', version: CONSENT_VERSION - 1 });
const staleServerDenial = consentRecord({ analytics: 'denied', version: CONSENT_VERSION - 1 });

describe('resolveConsent', () => {
  it('returns null when neither side has answered', () => {
    expect(resolveConsent(null, null)).toBeNull();
  });

  it('lets an account denial win over a device grant', () => {
    expect(resolveConsent(localGrant, serverDenial)).toBe(serverDenial);
  });

  it('lets an account denial win over no device answer', () => {
    expect(resolveConsent(null, serverDenial)).toBe(serverDenial);
  });

  it('keeps a device denial when the account also says no', () => {
    expect(resolveConsent(localDenial, serverDenial)?.analytics).toBe('denied');
  });

  it('applies an account grant to a device that has no answer of its own', () => {
    expect(resolveConsent(null, serverGrant)).toBe(serverGrant);
  });

  it('never lets an account grant override a device denial', () => {
    // The rule the prompt copy depends on: "No thanks" on this phone stays
    // "No thanks" even after the climber said yes on the web.
    expect(resolveConsent(localDenial, serverGrant)).toBe(localDenial);
  });

  it('keeps the device grant when the account also granted', () => {
    expect(resolveConsent(localGrant, serverGrant)).toBe(localGrant);
  });

  it('keeps the device answer when the account has none', () => {
    expect(resolveConsent(localGrant, null)).toBe(localGrant);
    expect(resolveConsent(localDenial, null)).toBe(localDenial);
  });

  it('ignores a device record from an older consent version', () => {
    expect(resolveConsent(staleLocalGrant, null)).toBeNull();
    // With the stale device answer gone, the account grant fills the gap.
    expect(resolveConsent(staleLocalGrant, serverGrant)).toBe(serverGrant);
  });

  it('ignores an account record from an older consent version', () => {
    expect(resolveConsent(localGrant, staleServerDenial)).toBe(localGrant);
    expect(resolveConsent(null, staleServerDenial)).toBeNull();
  });

  it('treats a record from a newer consent version as current', () => {
    // An older bundle reading a newer bundle's answer must not re-ask or drop it.
    const newerDenial = consentRecord({ analytics: 'denied', version: CONSENT_VERSION + 1 });
    expect(resolveConsent(localGrant, newerDenial)).toBe(newerDenial);
  });
});

describe('needsPrompt', () => {
  it('asks when there is no answer', () => {
    expect(needsPrompt(null)).toBe(true);
  });

  it('asks again when the answer predates the current version', () => {
    expect(needsPrompt(staleLocalGrant)).toBe(true);
  });

  it.each([localGrant, localDenial])('does not ask when a current answer exists (%o)', (record) => {
    expect(needsPrompt(record)).toBe(false);
  });
});

describe('isAnalyticsGranted', () => {
  it('is true only for a current grant', () => {
    expect(isAnalyticsGranted(localGrant)).toBe(true);
  });

  it('is false for a denial, no answer, or a stale grant', () => {
    expect(isAnalyticsGranted(localDenial)).toBe(false);
    expect(isAnalyticsGranted(null)).toBe(false);
    expect(isAnalyticsGranted(staleLocalGrant)).toBe(false);
  });
});

describe('isCurrentConsentRecord', () => {
  it('accepts the current and newer versions and rejects older ones and null', () => {
    expect(isCurrentConsentRecord(localGrant)).toBe(true);
    expect(isCurrentConsentRecord(consentRecord({ version: CONSENT_VERSION + 3 }))).toBe(true);
    expect(isCurrentConsentRecord(staleLocalGrant)).toBe(false);
    expect(isCurrentConsentRecord(null)).toBe(false);
  });
});

describe('type guards', () => {
  it('recognises only the two consent choices', () => {
    expect(isAnalyticsConsentChoice('granted')).toBe(true);
    expect(isAnalyticsConsentChoice('denied')).toBe(true);
    expect(isAnalyticsConsentChoice('GRANTED')).toBe(false);
    expect(isAnalyticsConsentChoice('')).toBe(false);
    expect(isAnalyticsConsentChoice(undefined)).toBe(false);
  });

  it('recognises only the three consent sources', () => {
    expect(isConsentSource('web')).toBe(true);
    expect(isConsentSource('ios')).toBe(true);
    expect(isConsentSource('android')).toBe(true);
    expect(isConsentSource('unknown')).toBe(false);
    expect(isConsentSource(1)).toBe(false);
  });
});

describe('device answer ownership', () => {
  it('belongs only to the account that was signed in when it was given', () => {
    expect(isConsentRecordOwnedBy({ ...localGrant, ownerAccountId: 'account-a' }, 'account-a')).toBe(true);
    expect(isConsentRecordOwnedBy({ ...localGrant, ownerAccountId: 'account-a' }, 'account-b')).toBe(false);
    expect(isConsentRecordOwnedBy({ ...localGrant, ownerAccountId: null }, 'account-a')).toBe(false);
    expect(isConsentRecordOwnedBy(localGrant, 'account-a')).toBe(false);
    expect(isConsentRecordOwnedBy({ ...localGrant, ownerAccountId: 'account-a' }, null)).toBe(false);
    expect(isConsentRecordOwnedBy(null, 'account-a')).toBe(false);
  });

  it('compares records field by field, owner included, ignoring key order and wire fields', () => {
    const reordered = { source: 'ios', decidedAt: localGrant.decidedAt, version: 1, analytics: 'granted' } as const;
    expect(isSameConsentRecord(localGrant, reordered)).toBe(true);
    expect(isSameConsentRecord(localGrant, { ...localGrant, __typename: 'AnalyticsConsent' } as ConsentRecord)).toBe(
      true,
    );
    expect(isSameConsentRecord(localGrant, { ...localGrant, ownerAccountId: null })).toBe(true);
    expect(isSameConsentRecord(localGrant, { ...localGrant, ownerAccountId: 'account-a' })).toBe(false);
    expect(isSameConsentRecord(localGrant, { ...localGrant, basedOnDecidedAt: null })).toBe(false);
    expect(
      isSameConsentRecord({ ...localGrant, basedOnDecidedAt: 'a' }, { ...localGrant, basedOnDecidedAt: 'b' }),
    ).toBe(false);
    expect(isSameConsentRecord(localGrant, localDenial)).toBe(false);
    expect(isSameConsentRecord(null, null)).toBe(true);
    expect(isSameConsentRecord(localGrant, null)).toBe(false);
  });
});
