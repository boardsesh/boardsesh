import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONSENT_VERSION,
  createRegionDefaultConsent,
  isAnalyticsConsentChoice,
  isConsentSource,
  type ConsentRecord,
  type DeviceConsentRecord,
} from '@boardsesh/consent';

const store = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
vi.mock('../preference-store', () => ({
  getPreference: async (key: string) => (store.values.has(key) ? structuredClone(store.values.get(key)) : null),
  setPreference: async (key: string, payload: unknown) => {
    store.values.set(key, structuredClone(payload));
  },
  removePreference: async (key: string) => {
    store.values.delete(key);
  },
}));

import { persistLocalConsent, readLocalConsent, REGION_DEFAULT_CONSENT_KEY } from '../consent-storage';

/**
 * The native reader every bundle before the region default shipped with,
 * copied from main as it was when this change was made. It reads only the
 * answer key and takes whatever it finds there as the climber's answer. The
 * #6342 reader that follows it reads the same key the same way.
 */
async function readLocalConsentAsThePreviousBundle(): Promise<ConsentRecord | null> {
  const candidate = store.values.get('analyticsConsent') ?? null;
  if (!candidate || typeof candidate !== 'object') return null;
  const record = candidate as Record<string, unknown>;
  if (!isAnalyticsConsentChoice(record.analytics) || !isConsentSource(record.source)) return null;
  if (typeof record.version !== 'number' || !Number.isInteger(record.version) || record.version < CONSENT_VERSION)
    return null;
  if (typeof record.decidedAt !== 'string' || !Number.isFinite(Date.parse(record.decidedAt))) return null;
  return record as ConsentRecord;
}

const regionDefault = createRegionDefaultConsent('ios', new Date('2026-10-11T09:00:00.000Z'));
const explicitDenial: DeviceConsentRecord = {
  analytics: 'denied',
  version: CONSENT_VERSION,
  decidedAt: '2026-10-11T10:00:00.000Z',
  source: 'ios',
  ownerAccountId: 'account-a',
  basedOnDecidedAt: null,
};

beforeEach(() => {
  store.values.clear();
});

describe('native consent storage and the region default', () => {
  it('keeps the region default out of the key older bundles read as an answer', async () => {
    await persistLocalConsent(regionDefault);

    expect(store.values.has('analyticsConsent')).toBe(false);
    // An embedded fallback or rolled-back bundle sees no answer and asks; it
    // can never read the default as an Allow and write it to the account.
    await expect(readLocalConsentAsThePreviousBundle()).resolves.toBeNull();
    expect(store.values.get(REGION_DEFAULT_CONSENT_KEY)).toEqual(regionDefault);
    await expect(readLocalConsent()).resolves.toEqual(regionDefault);
  });

  it('moves an explicit answer back to the answer key and drops the default', async () => {
    await persistLocalConsent(regionDefault);
    await persistLocalConsent(explicitDenial);

    expect(store.values.has(REGION_DEFAULT_CONSENT_KEY)).toBe(false);
    await expect(readLocalConsentAsThePreviousBundle()).resolves.toEqual(explicitDenial);
    await expect(readLocalConsent()).resolves.toEqual(explicitDenial);
  });

  it('clears both keys for no answer', async () => {
    await persistLocalConsent(regionDefault);
    await persistLocalConsent(null);
    expect(store.values.size).toBe(0);
    await expect(readLocalConsent()).resolves.toBeNull();
  });

  it('reads the climber’s own answer before a default left beside it', async () => {
    store.values.set(REGION_DEFAULT_CONSENT_KEY, regionDefault);
    store.values.set('analyticsConsent', explicitDenial);
    await expect(readLocalConsent()).resolves.toEqual(explicitDenial);
  });

  it('never gives a stored region default an owner or a write token', async () => {
    store.values.set(REGION_DEFAULT_CONSENT_KEY, {
      ...regionDefault,
      ownerAccountId: 'account-a',
      basedOnDecidedAt: null,
    });
    await expect(readLocalConsent()).resolves.toEqual(regionDefault);
  });

  it.each([
    ['a denial', { ...regionDefault, analytics: 'denied' }],
    ['an explicit answer', { ...regionDefault, basis: 'explicit' }],
    ['no basis', { ...regionDefault, basis: undefined }],
  ])('reads %s under the region-default key as no answer', async (_name, stored) => {
    store.values.set(REGION_DEFAULT_CONSENT_KEY, stored);
    await expect(readLocalConsent()).resolves.toBeNull();
  });

  it('reads a region default an early preview left under the answer key as no answer', async () => {
    store.values.set('analyticsConsent', regionDefault);
    await expect(readLocalConsent()).resolves.toBeNull();
    // The gate then applies the default again, which moves it to its own key.
    await persistLocalConsent(regionDefault);
    expect(store.values.has('analyticsConsent')).toBe(false);
  });
});
