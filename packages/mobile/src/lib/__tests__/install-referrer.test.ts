import { beforeEach, describe, expect, it, vi } from 'vitest';

const preferenceStore = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
}));
const analytics = vi.hoisted(() => ({ track: vi.fn(), setPersonProperties: vi.fn() }));

vi.mock('../preference-store', () => ({
  getPreference: vi.fn(async (key: string) => preferenceStore.values.get(key) ?? null),
  setPreference: vi.fn(async (key: string, value: unknown) => {
    preferenceStore.values.set(key, value);
  }),
}));
vi.mock('../analytics', () => ({ track: analytics.track, setPersonProperties: analytics.setPersonProperties }));
// Every test drives maybeFetchAndAttachInstallReferrer via its injectable
// `fetchNative` param, so the native module itself is never exercised — but
// install-referrer.ts still imports it at module scope (for the default
// param), and the real module transitively calls expo-modules-core's
// requireOptionalNativeModule, which can't resolve under vitest's node env.
vi.mock('../../../modules/install-referrer/src/index', () => ({ installReferrerNative: null }));

import { maybeFetchAndAttachInstallReferrer, parseInstallReferrer } from '../install-referrer';
import { getPreference, setPreference } from '../preference-store';

const getPreferenceMock = vi.mocked(getPreference);
const setPreferenceMock = vi.mocked(setPreference);

beforeEach(() => {
  preferenceStore.values.clear();
  analytics.track.mockClear();
  analytics.setPersonProperties.mockClear();
  getPreferenceMock.mockClear();
  setPreferenceMock.mockClear();
});

describe('parseInstallReferrer', () => {
  it('extracts utm_source/medium/campaign and preserves the raw string', () => {
    const parsed = parseInstallReferrer('utm_source=google&utm_medium=cpc&utm_campaign=spring_sale');

    expect(parsed).toEqual({
      raw: 'utm_source=google&utm_medium=cpc&utm_campaign=spring_sale',
      source: 'google',
      medium: 'cpc',
      campaign: 'spring_sale',
    });
  });

  it('resolves missing params to null', () => {
    const parsed = parseInstallReferrer('');

    expect(parsed).toEqual({ raw: '', source: null, medium: null, campaign: null });
  });

  it('round-trips an unrecognized param inside `raw` without dropping it', () => {
    const raw = 'utm_source=google&gclid=abc123';
    const parsed = parseInstallReferrer(raw);

    expect(parsed.raw).toBe(raw);
    expect(parsed.source).toBe('google');
  });
});

describe('maybeFetchAndAttachInstallReferrer', () => {
  it('fetches once, marks the flag, and attaches parsed referrer data', async () => {
    const fetchNative = vi.fn(async () => ({
      installReferrer: 'utm_source=google&utm_medium=cpc&utm_campaign=spring_sale',
      referrerClickTimestampSeconds: 100,
      installBeginTimestampSeconds: 200,
    }));

    await maybeFetchAndAttachInstallReferrer(fetchNative);

    expect(fetchNative).toHaveBeenCalledTimes(1);
    expect(setPreferenceMock).toHaveBeenCalledWith('installReferrerFetched', true);
    expect(analytics.setPersonProperties).toHaveBeenCalledWith(undefined, {
      install_referrer_raw: 'utm_source=google&utm_medium=cpc&utm_campaign=spring_sale',
      install_source: 'google',
      install_medium: 'cpc',
      install_campaign: 'spring_sale',
      install_click_timestamp: 100,
      install_begin_timestamp: 200,
    });
    expect(analytics.track).toHaveBeenCalledWith('Install Attributed', {
      install_source: 'google',
      install_medium: 'cpc',
      install_campaign: 'spring_sale',
    });
  });

  it('skips the native call entirely once already fetched', async () => {
    preferenceStore.values.set('installReferrerFetched', true);
    const fetchNative = vi.fn(async () => null);

    await maybeFetchAndAttachInstallReferrer(fetchNative);

    expect(fetchNative).not.toHaveBeenCalled();
    expect(analytics.setPersonProperties).not.toHaveBeenCalled();
    expect(analytics.track).not.toHaveBeenCalled();
  });

  it('marks the flag fetched but attaches nothing when the native call resolves null', async () => {
    const fetchNative = vi.fn(async () => null);

    await maybeFetchAndAttachInstallReferrer(fetchNative);

    expect(setPreferenceMock).toHaveBeenCalledWith('installReferrerFetched', true);
    expect(analytics.setPersonProperties).not.toHaveBeenCalled();
    expect(analytics.track).not.toHaveBeenCalled();
  });

  it('never throws when the native call rejects, and leaves the flag unset so the next launch retries', async () => {
    const fetchNative = vi.fn(async () => {
      throw new Error('SERVICE_UNAVAILABLE');
    });

    await expect(maybeFetchAndAttachInstallReferrer(fetchNative)).resolves.toBeUndefined();

    expect(setPreferenceMock).not.toHaveBeenCalled();
    expect(analytics.setPersonProperties).not.toHaveBeenCalled();
    expect(analytics.track).not.toHaveBeenCalled();
  });
});
