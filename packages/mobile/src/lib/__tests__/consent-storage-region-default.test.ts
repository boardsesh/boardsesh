import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONSENT_VERSION,
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

const regionDefault: DeviceConsentRecord = {
  analytics: 'granted',
  version: CONSENT_VERSION,
  source: 'ios',
  decidedAt: '2026-10-11T09:00:00.000Z',
  basis: 'region_default',
};
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

describe('native consent storage migration', () => {
  it.each(['analyticsConsent', REGION_DEFAULT_CONSENT_KEY])('drops an old default under %s', async (key) => {
    store.values.set(key, regionDefault);
    await expect(readLocalConsent()).resolves.toBeNull();
    expect(store.values.has(key)).toBe(false);
  });
  it.each(['granted', 'denied'] as const)('preserves an explicit %s, even beside an old default', async (analytics) => {
    const explicit = { ...explicitDenial, analytics };
    store.values.set(REGION_DEFAULT_CONSENT_KEY, regionDefault);
    store.values.set('analyticsConsent', explicit);
    await expect(readLocalConsent()).resolves.toEqual(explicit);
    await expect(readLocalConsentAsThePreviousBundle()).resolves.toEqual(explicit);
    expect(store.values.has(REGION_DEFAULT_CONSENT_KEY)).toBe(false);
  });
  it('cannot persist a region default as permission', async () => {
    await persistLocalConsent(regionDefault);
    expect(store.values.size).toBe(0);
    await expect(readLocalConsent()).resolves.toBeNull();
  });
  it('keeps Settings decisions readable by current and older bundles', async () => {
    await persistLocalConsent(explicitDenial);
    await expect(readLocalConsent()).resolves.toEqual(explicitDenial);
    await expect(readLocalConsentAsThePreviousBundle()).resolves.toEqual(explicitDenial);
    await persistLocalConsent(null);
    expect(store.values.size).toBe(0);
  });
});
