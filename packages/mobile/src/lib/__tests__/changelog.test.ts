import { describe, it, expect } from 'vitest';
import { composeTimeline, isNativeRelease, type ChangelogEntry, type NativeRelease } from '../changelog-timeline';

const entry = (over: Partial<ChangelogEntry> & { prNumber: number }): ChangelogEntry => ({
  category: 'new',
  title: `Title ${over.prNumber}`,
  mergedAt: '2026-06-15T12:00:00Z',
  prUrl: `https://github.com/boardsesh/boardsesh/pull/${over.prNumber}`,
  ...over,
});

const release = (over: Partial<NativeRelease>): NativeRelease => ({
  kind: 'native-release',
  date: '2026-06-16T00:00:00Z',
  sha: 'sha-1',
  platforms: ['ios'],
  fingerprints: {},
  ...over,
});

describe('isNativeRelease', () => {
  it('discriminates markers from entries', () => {
    expect(isNativeRelease(release({}))).toBe(true);
    expect(isNativeRelease(entry({ prNumber: 1 }))).toBe(false);
  });
});

describe('composeTimeline', () => {
  it('shows a marker only on its own platform', () => {
    const releases = [
      release({ sha: 'ios-only', platforms: ['ios'] }),
      release({ sha: 'android-only', platforms: ['android'] }),
    ];
    expect(
      composeTimeline([], releases, 'ios')
        .filter(isNativeRelease)
        .map((r) => r.sha),
    ).toEqual(['ios-only']);
    expect(
      composeTimeline([], releases, 'android')
        .filter(isNativeRelease)
        .map((r) => r.sha),
    ).toEqual(['android-only']);
  });

  it('shows a both-platform marker on either platform', () => {
    const both = [release({ sha: 'both', platforms: ['android', 'ios'] })];
    expect(composeTimeline([], both, 'ios').filter(isNativeRelease)).toHaveLength(1);
    expect(composeTimeline([], both, 'android').filter(isNativeRelease)).toHaveLength(1);
  });

  it('interleaves entries and markers newest-first by date', () => {
    const items = composeTimeline(
      [
        entry({ prNumber: 1, mergedAt: '2026-06-14T00:00:00Z' }),
        entry({ prNumber: 2, mergedAt: '2026-06-18T00:00:00Z' }),
      ],
      [release({ sha: 's16', date: '2026-06-16T00:00:00Z', platforms: ['ios'] })],
      'ios',
    );
    const ids = items.map((item) => (isNativeRelease(item) ? `native-${item.sha}` : `pr-${item.prNumber}`));
    expect(ids).toEqual(['pr-2', 'native-s16', 'pr-1']);
  });

  it('returns only entries when there are no markers', () => {
    const items = composeTimeline([entry({ prNumber: 1 })], [], 'ios');
    expect(items).toHaveLength(1);
    expect(items.some(isNativeRelease)).toBe(false);
  });
});
