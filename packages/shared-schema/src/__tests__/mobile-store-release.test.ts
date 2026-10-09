import { describe, expect, it } from 'vitest';
import {
  compareNumericVersions,
  parseNumericVersion,
  parseStoreReleaseSnapshot,
  resolveMobileStoreRelease,
  type StoreReleaseSnapshot,
} from '../mobile-store-release';
const now = Date.parse('2026-10-06T12:00:00.000Z');
const snapshot: StoreReleaseSnapshot = {
  schemaVersion: 1,
  checkedAt: new Date(now).toISOString(),
  latestVersion: '2.9.1',
  firstPublicAtByMinor: {
    '2.7': '2026-07-01T12:00:00.000Z',
    '2.8': '2026-08-01T12:00:00.000Z',
    '2.9': '2026-09-01T12:00:00.000Z',
  },
};
describe('mobile store release contract', () => {
  it('compares versions numerically and rejects malformed inputs', () => {
    expect(compareNumericVersions('2.10.0', '2.9.9')).toBe(1);
    for (const invalid of [null, undefined, '2.6', '2.6.0-beta', '02.6.0', '2.6.99999999999999999999'])
      expect(parseNumericVersion(invalid)).toBeNull();
  });
  it('preserves earliest qualifying date across successive minor releases', () => {
    expect(resolveMobileStoreRelease(snapshot, '2.6.2', 'https://store.example', now)?.firstNewerMinorAvailableAt).toBe(
      '2026-07-01T12:00:00.000Z',
    );
    expect(resolveMobileStoreRelease(snapshot, '2.8.0', 'https://store.example', now)?.firstNewerMinorAvailableAt).toBe(
      '2026-09-01T12:00:00.000Z',
    );
  });
  it('suppresses patch-only, newer installed, withdrawal, and rollback-ineligible versions', () => {
    for (const version of ['2.9.0', '2.9.1', '2.10.0', '3.0.0'])
      expect(resolveMobileStoreRelease(snapshot, version, '', now)).toBeNull();
    expect(resolveMobileStoreRelease({ ...snapshot, latestVersion: null }, '2.6.0', '', now)).toBeNull();
    expect(resolveMobileStoreRelease({ ...snapshot, latestVersion: '2.7.0' }, '2.8.0', '', now)).toBeNull();
    expect(
      resolveMobileStoreRelease({ ...snapshot, latestVersion: '2.7.0' }, '2.6.0', '', now)?.firstNewerMinorAvailableAt,
    ).toBe(snapshot.firstPublicAtByMinor['2.7']);
  });
  it('checks exact freshness boundaries and future dates', () => {
    expect(resolveMobileStoreRelease(snapshot, '2.6.0', '', now + 86400000)).not.toBeNull();
    expect(resolveMobileStoreRelease(snapshot, '2.6.0', '', now + 86400001)).toBeNull();
    expect(resolveMobileStoreRelease(snapshot, '2.6.0', '', now - 1)).toBeNull();
  });
  it('rejects malformed metadata and missing target history', () => {
    expect(parseStoreReleaseSnapshot({ ...snapshot, checkedAt: '2026-02-30T12:00:00.000Z' })).toBeNull();
    expect(
      parseStoreReleaseSnapshot({ ...snapshot, firstPublicAtByMinor: { '2.9': '2026-10-07T12:00:00.000Z' } }),
    ).toBeNull();
    expect(parseStoreReleaseSnapshot({ ...snapshot, firstPublicAtByMinor: {} })).toBeNull();
    expect(parseStoreReleaseSnapshot({ ...snapshot, latestVersion: undefined })).toBeNull();
  });
});
