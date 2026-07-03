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
vi.mock('../error-reporting', () => ({ reportError: vi.fn() }));
// Every test drives maybeFetchAndAttachInstallReferrer via its injectable
// `fetchNative` param, so the native module itself is never exercised — but
// install-referrer.ts still imports it at module scope (for the default
// param), and the real module transitively calls expo-modules-core's
// requireOptionalNativeModule, which can't resolve under vitest's node env.
vi.mock('../../../modules/install-referrer/src/index', () => ({ installReferrerNative: null }));

import {
  INSTALL_ATTRIBUTED_EVENT,
  maybeFetchAndAttachInstallReferrer,
  parseInstallReferrer,
  resetInstallReferrerFetchInFlightForTests,
} from '../install-referrer';
import { getPreference, setPreference } from '../preference-store';
import { reportError } from '../error-reporting';

const getPreferenceMock = vi.mocked(getPreference);
const setPreferenceMock = vi.mocked(setPreference);
const reportErrorMock = vi.mocked(reportError);

beforeEach(() => {
  preferenceStore.values.clear();
  analytics.track.mockClear();
  analytics.setPersonProperties.mockClear();
  getPreferenceMock.mockClear();
  setPreferenceMock.mockClear();
  reportErrorMock.mockClear();
  resetInstallReferrerFetchInFlightForTests();
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

  it('decodes URL-encoded params for the parsed fields but preserves raw verbatim', () => {
    // URLSearchParams treats a literal `+` as a space (application/x-www-form-
    // urlencoded convention) and decodes %XX escapes for the parsed fields —
    // intentional, since that's the correct decoding of a query string. `raw`
    // stays untouched either way, so nothing is lost if that divergence ever
    // matters downstream.
    const raw = 'utm_campaign=spring+sale&utm_source=go%20ogle';
    const parsed = parseInstallReferrer(raw);

    expect(parsed.raw).toBe(raw);
    expect(parsed.campaign).toBe('spring sale');
    expect(parsed.source).toBe('go ogle');
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
    expect(analytics.track).toHaveBeenCalledWith(INSTALL_ATTRIBUTED_EVENT, {
      install_source: 'google',
      install_medium: 'cpc',
      install_campaign: 'spring_sale',
    });
  });

  it('writes person properties but does NOT fire Install Attributed for an organic install (no utm params)', async () => {
    const fetchNative = vi.fn(async () => ({
      installReferrer: '',
      referrerClickTimestampSeconds: 0,
      installBeginTimestampSeconds: 300,
    }));

    await maybeFetchAndAttachInstallReferrer(fetchNative);

    expect(analytics.setPersonProperties).toHaveBeenCalledWith(undefined, {
      install_referrer_raw: '',
      install_source: null,
      install_medium: null,
      install_campaign: null,
      install_click_timestamp: 0,
      install_begin_timestamp: 300,
    });
    expect(analytics.track).not.toHaveBeenCalled();
  });

  it('ignores a concurrent overlapping call — only the first invocation reaches fetchNative', async () => {
    let resolveFetch: (() => void) | undefined;
    const fetchNative = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          resolveFetch = () => resolve(null);
        }),
    );

    const first = maybeFetchAndAttachInstallReferrer(fetchNative);
    // Give the first call's getPreference() microtask a chance to resolve and
    // set fetchInFlight before the second call starts, mirroring a real
    // remount racing the first mount's in-flight fetch.
    await Promise.resolve();
    const second = maybeFetchAndAttachInstallReferrer(fetchNative);

    resolveFetch?.();
    await Promise.all([first, second]);

    expect(fetchNative).toHaveBeenCalledTimes(1);
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

  it('never throws when the native call rejects, reports the error, and leaves the flag unset so the next launch retries', async () => {
    const rejection = new Error('SERVICE_UNAVAILABLE');
    const fetchNative = vi.fn(async () => {
      throw rejection;
    });

    await expect(maybeFetchAndAttachInstallReferrer(fetchNative)).resolves.toBeUndefined();

    expect(setPreferenceMock).not.toHaveBeenCalled();
    expect(analytics.setPersonProperties).not.toHaveBeenCalled();
    expect(analytics.track).not.toHaveBeenCalled();
    expect(reportErrorMock).toHaveBeenCalledWith(rejection);

    // The flag was never set, so a second call (the next launch) actually
    // re-invokes fetchNative instead of short-circuiting like the
    // already-fetched case above.
    await maybeFetchAndAttachInstallReferrer(fetchNative);
    expect(fetchNative).toHaveBeenCalledTimes(2);
  });

  it('never throws when setPreference rejects after a successful fetch, reports the error, and leaves the flag unset so the next launch retries', async () => {
    const rejection = new Error('AsyncStorage write failed');
    setPreferenceMock.mockRejectedValueOnce(rejection);
    const fetchNative = vi.fn(async () => ({
      installReferrer: 'utm_source=google',
      referrerClickTimestampSeconds: 100,
      installBeginTimestampSeconds: 200,
    }));

    await expect(maybeFetchAndAttachInstallReferrer(fetchNative)).resolves.toBeUndefined();

    expect(fetchNative).toHaveBeenCalledTimes(1);
    // The flag write itself is what rejected, so the attribution attach steps
    // after it never run — the failed write is the reported error, not a
    // downstream side effect.
    expect(analytics.setPersonProperties).not.toHaveBeenCalled();
    expect(analytics.track).not.toHaveBeenCalled();
    expect(reportErrorMock).toHaveBeenCalledWith(rejection);
  });

  it('never throws when getPreference itself rejects, reports the error, and never reaches fetchNative', async () => {
    const rejection = new Error('AsyncStorage unavailable');
    getPreferenceMock.mockRejectedValueOnce(rejection);
    const fetchNative = vi.fn(async () => null);

    await expect(maybeFetchAndAttachInstallReferrer(fetchNative)).resolves.toBeUndefined();

    expect(fetchNative).not.toHaveBeenCalled();
    expect(setPreferenceMock).not.toHaveBeenCalled();
    expect(analytics.setPersonProperties).not.toHaveBeenCalled();
    expect(analytics.track).not.toHaveBeenCalled();
    expect(reportErrorMock).toHaveBeenCalledWith(rejection);
  });
});
