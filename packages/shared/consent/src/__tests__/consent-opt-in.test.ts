import { describe, expect, it, vi } from 'vitest';
import {
  CONSENT_VERSION,
  createConsentSyncCoordinator,
  isAnalyticsGranted,
  isRegionDefaultConsent,
  isSameConsentRecord,
  mergeAccountConsent,
  needsPrompt,
  parseConsentCookieValue,
  parsePendingConsentDecision,
  resolveConsent,
  serializeConsentCookieValue,
  type ConsentRecord,
} from '../index';

const regionDefault: ConsentRecord = {
  analytics: 'granted',
  version: CONSENT_VERSION,
  source: 'ios',
  decidedAt: '2026-10-11T09:00:00.000Z',
  basis: 'region_default',
};
const accountGrant: ConsentRecord = {
  analytics: 'granted',
  version: CONSENT_VERSION,
  source: 'web',
  decidedAt: '2026-10-01T10:00:00.123Z',
};
const accountDenial: ConsentRecord = { ...accountGrant, analytics: 'denied' };

function signedInCoordinator(initialRecord: ConsentRecord | null, account: ConsentRecord | null) {
  const readAccountConsent = vi.fn(async (_accountId: string): Promise<ConsentRecord | null> => account);
  const writeAccountConsent = vi.fn(
    async (_accountId: string, input: { analytics: 'granted' | 'denied' }): Promise<ConsentRecord> => ({
      ...accountGrant,
      analytics: input.analytics,
      decidedAt: '2026-10-11T10:00:00.000Z',
    }),
  );
  const persistLocalConsent = vi.fn();
  const coordinator = createConsentSyncCoordinator({
    initialRecord,
    readAccountConsent,
    writeAccountConsent,
    persistLocalConsent,
    persistPendingDecision: async () => {},
  });
  coordinator.setAccount('account-a');
  return { coordinator, readAccountConsent, writeAccountConsent, persistLocalConsent };
}

describe('legacy region-default migration', () => {
  it('never enables analytics and requires an explicit answer', () => {
    expect(regionDefault).toEqual({
      analytics: 'granted',
      version: CONSENT_VERSION,
      decidedAt: '2026-10-11T09:00:00.000Z',
      source: 'ios',
      basis: 'region_default',
    });
    expect(isRegionDefaultConsent(regionDefault)).toBe(true);
    expect(needsPrompt(regionDefault)).toBe(true);
    expect(isAnalyticsGranted(regionDefault)).toBe(false);
  });

  it('reads a record without a basis as explicit, so stored answers stay valid', () => {
    expect(isRegionDefaultConsent(accountGrant)).toBe(false);
    expect(isRegionDefaultConsent(null)).toBe(false);
  });

  it('reads the old region-default cookie as unanswered and preserves explicit cookies', () => {
    expect(parseConsentCookieValue('v1.granted.1767225600.web.region')).toBeNull();
    expect(serializeConsentCookieValue({ ...accountGrant, basis: 'explicit' }).split('.')).toHaveLength(4);
    for (const analytics of ['granted', 'denied'] as const) {
      const explicit = { ...accountGrant, analytics };
      expect(parseConsentCookieValue(serializeConsentCookieValue(explicit))?.analytics).toBe(analytics);
      expect(needsPrompt(explicit)).toBe(false);
    }
  });

  it.each(['v1.denied.1767225600.web.region', 'v1.granted.1767225600.web.explicit', 'v1.granted.1767225600.web.'])(
    'reads a fifth part it did not write as no answer: %s',
    (value) => {
      expect(parseConsentCookieValue(value)).toBeNull();
    },
  );

  it('is refused as a persisted pending account write, rather than stripped into a grant', () => {
    expect(parsePendingConsentDecision({ record: regionDefault, basedOnDecidedAt: null })).toBeNull();
    expect(
      parsePendingConsentDecision({ record: { ...regionDefault, basis: 'guessed' }, basedOnDecidedAt: null }),
    ).toBeNull();
    const explicit = parsePendingConsentDecision({
      record: { ...accountGrant, basis: 'explicit' },
      basedOnDecidedAt: null,
    });
    expect(explicit?.record).toEqual(accountGrant);
  });
});

describe('resolveConsent with a region default', () => {
  it('lets an account denial win', () => {
    expect(resolveConsent(regionDefault, accountDenial)).toBe(accountDenial);
  });

  it('lets an account grant replace it with the explicit answer', () => {
    expect(resolveConsent(regionDefault, accountGrant)).toBe(accountGrant);
  });

  it('drops it when the account has no answer', () => {
    expect(resolveConsent(regionDefault, null)).toBeNull();
  });
});

describe('mergeAccountConsent with a region default', () => {
  it('drops the old default when the account has no answer, and writes nothing', () => {
    const merged = mergeAccountConsent(regionDefault, null, 'account-a');
    expect(merged.record).toBeNull();
    expect(merged.push).toBeNull();
  });

  it('replaces it with the account grant, as an account copy with no basis', () => {
    const merged = mergeAccountConsent(regionDefault, accountGrant, 'account-a');
    expect(merged).toEqual({ record: { ...accountGrant, ownerAccountId: 'account-a' }, push: null });
    expect(merged.record).not.toHaveProperty('basis');
    expect(merged.record).not.toHaveProperty('basedOnDecidedAt');
  });

  it('replaces it with the account denial', () => {
    const merged = mergeAccountConsent(regionDefault, accountDenial, 'account-a');
    expect(merged).toEqual({ record: { ...accountDenial, ownerAccountId: 'account-a' }, push: null });
    expect(isRegionDefaultConsent(merged.record)).toBe(false);
  });

  it('is never pushed, even if storage bound it to this account with a write token', () => {
    const bound = { ...regionDefault, ownerAccountId: 'account-a', basedOnDecidedAt: null };
    expect(mergeAccountConsent(bound, null, 'account-a')).toEqual({ record: null, push: null });
  });
});

describe('isSameConsentRecord and basis', () => {
  it('tells a region default from an explicit grant made at the same moment', () => {
    const explicit: ConsentRecord = {
      analytics: 'granted',
      version: regionDefault.version,
      decidedAt: regionDefault.decidedAt,
      source: regionDefault.source,
    };
    expect(isSameConsentRecord(regionDefault, explicit)).toBe(false);
    expect(isSameConsentRecord(explicit, { ...explicit, basis: 'explicit' })).toBe(true);
    expect(isSameConsentRecord(regionDefault, { ...regionDefault })).toBe(true);
  });
});

describe('account sync with a region default', () => {
  it('never writes the region default to an empty account', async () => {
    const { coordinator, writeAccountConsent } = signedInCoordinator(regionDefault, null);
    expect(coordinator.getSnapshot().record).toBeNull();
    await coordinator.sync();
    expect(writeAccountConsent).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().record).toBeNull();
    expect(coordinator.getSnapshot().accountResolved).toBe(true);
  });

  it('rejects a region default introduced after the account read', async () => {
    const { coordinator, readAccountConsent, writeAccountConsent } = signedInCoordinator(null, null);
    await coordinator.sync();
    coordinator.replaceLocalRecord(regionDefault);
    expect(coordinator.getSnapshot().accountResolved).toBe(true);
    await coordinator.sync();
    expect(readAccountConsent).toHaveBeenCalledTimes(2);
    expect(writeAccountConsent).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().record).toBeNull();
  });

  it('keeps the device unanswered across repeated account reads without a write', async () => {
    const { coordinator, readAccountConsent, writeAccountConsent } = signedInCoordinator(regionDefault, null);
    await coordinator.sync();
    await coordinator.sync();
    expect(readAccountConsent).toHaveBeenCalledTimes(2);
    expect(writeAccountConsent).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot().record).toBeNull();
  });

  it('gives way to an account grant and writes nothing', async () => {
    const { coordinator, writeAccountConsent } = signedInCoordinator(regionDefault, accountGrant);
    await coordinator.sync();
    expect(coordinator.getSnapshot().record).toEqual({ ...accountGrant, ownerAccountId: 'account-a' });
    expect(writeAccountConsent).not.toHaveBeenCalled();
  });

  it('gives way to an account denial and writes nothing', async () => {
    const { coordinator, writeAccountConsent, persistLocalConsent } = signedInCoordinator(regionDefault, accountDenial);
    await coordinator.sync();
    expect(coordinator.getSnapshot().record).toEqual({ ...accountDenial, ownerAccountId: 'account-a' });
    expect(persistLocalConsent).toHaveBeenLastCalledWith({ ...accountDenial, ownerAccountId: 'account-a' });
    expect(writeAccountConsent).not.toHaveBeenCalled();
  });

  it('turns into an explicit answer when the climber toggles analytics in Settings', async () => {
    const { coordinator, writeAccountConsent } = signedInCoordinator(regionDefault, null);
    await coordinator.sync();
    await coordinator.decide('denied', 'ios');
    expect(writeAccountConsent).toHaveBeenCalledOnce();
    expect(writeAccountConsent.mock.calls[0]?.[1]).toEqual({
      analytics: 'denied',
      version: CONSENT_VERSION,
      source: 'ios',
      basedOnDecidedAt: null,
    });
    expect(isRegionDefaultConsent(coordinator.getSnapshot().record)).toBe(false);

    await coordinator.decide('granted', 'ios');
    expect(writeAccountConsent).toHaveBeenCalledTimes(2);
    expect(coordinator.getSnapshot().record?.analytics).toBe('granted');
    expect(isRegionDefaultConsent(coordinator.getSnapshot().record)).toBe(false);
  });

  it('records an explicit signed-out choice without the region marker', async () => {
    const persistLocalConsent = vi.fn();
    const coordinator = createConsentSyncCoordinator({
      initialRecord: regionDefault,
      readAccountConsent: async () => null,
      writeAccountConsent: async () => accountGrant,
      persistLocalConsent,
    });
    await coordinator.decide('granted', 'android');
    const persisted = persistLocalConsent.mock.lastCall?.[0] as ConsentRecord;
    expect(persisted.analytics).toBe('granted');
    expect(isRegionDefaultConsent(persisted)).toBe(false);
  });
});
