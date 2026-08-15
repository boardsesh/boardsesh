import { describe, expect, it } from 'vitest';

import {
  bumpPatch,
  formatBuildTag,
  formatReleaseTag,
  parseBuildTag,
  parseReleaseTag,
  pickBuildTagForVersion,
  pickExactBuildTag,
  selectReleaseCandidate,
  selectReleaseCandidateFromEquivalentTags,
  selectHighestAcceptedBuildTags,
  shortFingerprint,
} from '../lib/release-tags';

const FP = 'a1b2c3d4e5f6a7b8'; // 16 hex chars
const SHORT = 'a1b2c3d4e5f6'; // first 12

describe('shortFingerprint', () => {
  it('takes the first 12 hex chars', () => {
    expect(shortFingerprint(FP)).toBe(SHORT);
  });

  it('lowercases and trims', () => {
    expect(shortFingerprint(`  ${FP.toUpperCase()}\n`)).toBe(SHORT);
  });

  it('rejects a too-short or non-hex value', () => {
    expect(() => shortFingerprint('a1b2c3')).toThrow();
    expect(() => shortFingerprint('nothexnothex')).toThrow();
  });
});

describe('formatBuildTag / parseBuildTag round-trip', () => {
  it('formats then parses back', () => {
    const tag = formatBuildTag('ios', '2.1.0', 42, SHORT);
    expect(tag).toBe('build-ios-v2.1.0-42-a1b2c3d4e5f6');
    expect(parseBuildTag(tag)).toEqual({ platform: 'ios', version: '2.1.0', buildNumber: 42, shortFp: SHORT });
  });

  it('handles a large Android versionCode', () => {
    const tag = formatBuildTag('android', '2.1.0', 2_000_042, SHORT);
    expect(parseBuildTag(tag)).toEqual({
      platform: 'android',
      version: '2.1.0',
      buildNumber: 2_000_042,
      shortFp: SHORT,
    });
  });

  it('rejects unrelated or malformed tags', () => {
    expect(parseBuildTag('fingerprint-ios-a1b2c3d4e5f6')).toBeNull();
    expect(parseBuildTag('build-web-v2.1.0-42-a1b2c3d4e5f6')).toBeNull();
    expect(parseBuildTag('build-ios-v2.1-42-a1b2c3d4e5f6')).toBeNull(); // not x.y.z
    expect(parseBuildTag('build-ios-v2.1.0-42-tooshort')).toBeNull();
  });
});

describe('formatReleaseTag / parseReleaseTag round-trip', () => {
  it('formats then parses back', () => {
    const tag = formatReleaseTag('android', '2.1.0', SHORT);
    expect(tag).toBe('release/android-v2.1.0-a1b2c3d4e5f6');
    expect(parseReleaseTag(tag)).toEqual({ platform: 'android', version: '2.1.0', shortFp: SHORT });
  });

  it('rejects a build tag or arbitrary release branch', () => {
    expect(parseReleaseTag('build-ios-v2.1.0-42-a1b2c3d4e5f6')).toBeNull();
    expect(parseReleaseTag('release/some-feature')).toBeNull();
  });
});

describe('pickBuildTagForVersion', () => {
  const tags = [
    'build-ios-v2.1.0-40-aaaaaaaaaaaa',
    'build-ios-v2.1.0-42-bbbbbbbbbbbb',
    'build-ios-v2.1.0-41-cccccccccccc',
    'build-ios-v2.0.9-99-dddddddddddd',
    'build-android-v2.1.0-2000041-eeeeeeeeeeee',
    'build-android-v2.1.0-2000042-ffffffffffff',
    'fingerprint-ios-a1b2c3d4e5f6', // noise
  ];

  it('returns the exact approved build number when present', () => {
    expect(pickBuildTagForVersion(tags, 'ios', '2.1.0', 41)).toMatchObject({
      buildNumber: 41,
      shortFp: 'cccccccccccc',
    });
  });

  it('returns null (never the highest) when a preferred build number has no exact match', () => {
    // Strict: a wrong-commit anchor is worse than none. The caller warns + skips.
    expect(pickBuildTagForVersion(tags, 'ios', '2.1.0', 999)).toBeNull();
  });

  it('falls back to the highest build number only when no preferred is given', () => {
    expect(pickBuildTagForVersion(tags, 'ios', '2.1.0')).toMatchObject({ buildNumber: 42, shortFp: 'bbbbbbbbbbbb' });
  });

  it('picks the sibling platform by highest build number', () => {
    expect(pickBuildTagForVersion(tags, 'android', '2.1.0')).toMatchObject({
      buildNumber: 2_000_042,
      shortFp: 'ffffffffffff',
    });
  });

  it('returns null when nothing matches the version', () => {
    expect(pickBuildTagForVersion(tags, 'ios', '9.9.9')).toBeNull();
    expect(pickBuildTagForVersion([], 'ios', '2.1.0')).toBeNull();
  });
});

describe('pickExactBuildTag', () => {
  const tags = ['build-ios-v2.1.0-42-aaaaaaaaaaaa', 'build-android-v2.1.0-2000042-bbbbbbbbbbbb'];

  it('finds iOS by version and build number, and Android by globally exact versionCode', () => {
    expect(pickExactBuildTag(tags, 'ios', 42, '2.1.0')).toMatchObject({ version: '2.1.0', buildNumber: 42 });
    expect(pickExactBuildTag(tags, 'android', 2_000_042)).toMatchObject({
      version: '2.1.0',
      buildNumber: 2_000_042,
    });
  });

  it('never falls back to another build or ambiguous duplicate tags', () => {
    expect(pickExactBuildTag(tags, 'android', 2_000_099)).toBeNull();
    expect(pickExactBuildTag([...tags, 'build-android-v2.2.0-2000042-cccccccccccc'], 'android', 2_000_042)).toBeNull();
  });
});

describe('selectReleaseCandidate', () => {
  const iosFingerprint = 'aaaaaaaaaaaa1111';
  const androidFingerprint = 'bbbbbbbbbbbb2222';
  const tags = [
    'build-ios-v2.1.0-41-aaaaaaaaaaaa',
    'build-ios-v2.1.0-42-aaaaaaaaaaaa',
    'build-android-v2.1.0-2000041-bbbbbbbbbbbb',
    'build-android-v2.1.0-2000042-bbbbbbbbbbbb',
    'build-ios-v2.0.9-99-aaaaaaaaaaaa',
  ];

  const acceptedBuilds = [
    { platform: 'ios' as const, versionString: '2.1.0', buildNumber: 42, state: 'READY_FOR_DISTRIBUTION' },
    {
      platform: 'android' as const,
      versionString: null,
      buildNumber: 2_000_042,
      state: 'RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED',
    },
  ];

  it('returns the highest exact accepted builds matching HEAD version and fingerprints', () => {
    expect(
      selectReleaseCandidate(tags, acceptedBuilds, '2.1.0', {
        ios: iosFingerprint,
        android: androidFingerprint,
      }),
    ).toEqual({
      ios: { platform: 'ios', version: '2.1.0', buildNumber: 42, shortFp: 'aaaaaaaaaaaa' },
      android: { platform: 'android', version: '2.1.0', buildNumber: 2_000_042, shortFp: 'bbbbbbbbbbbb' },
    });
  });

  it('allows JS-only HEAD drift because matching fingerprints, not commit SHAs, define native equivalence', () => {
    const tagsFromEarlierCommits = [...tags];
    expect(
      selectReleaseCandidate(tagsFromEarlierCommits, acceptedBuilds, '2.1.0', {
        ios: iosFingerprint,
        android: androidFingerprint,
      }),
    ).not.toBeNull();
  });

  it('fails closed when the highest HEAD-equivalent build is not accepted', () => {
    expect(
      selectReleaseCandidate([...tags, 'build-ios-v2.1.0-43-aaaaaaaaaaaa'], acceptedBuilds, '2.1.0', {
        ios: iosFingerprint,
        android: androidFingerprint,
      }),
    ).toBeNull();
  });

  it('fails closed on wrong version, fingerprint, missing platform, or duplicate highest tag', () => {
    expect(
      selectReleaseCandidate(tags, acceptedBuilds, '2.2.0', {
        ios: iosFingerprint,
        android: androidFingerprint,
      }),
    ).toBeNull();
    expect(
      selectReleaseCandidate(tags, acceptedBuilds, '2.1.0', {
        ios: 'cccccccccccc3333',
        android: androidFingerprint,
      }),
    ).toBeNull();
    expect(
      selectReleaseCandidate(tags, acceptedBuilds.slice(0, 1), '2.1.0', {
        ios: iosFingerprint,
        android: androidFingerprint,
      }),
    ).toBeNull();
    expect(
      selectReleaseCandidate([...tags, 'build-ios-v2.1.0-42-aaaaaaaaaaaa'], acceptedBuilds, '2.1.0', {
        ios: iosFingerprint,
        android: androidFingerprint,
      }),
    ).toBeNull();
  });
});

describe('selectReleaseCandidateFromEquivalentTags', () => {
  const acceptedBuilds = [
    { platform: 'ios' as const, versionString: '2.1.0', buildNumber: 42, state: 'READY_FOR_DISTRIBUTION' },
    {
      platform: 'android' as const,
      versionString: null,
      buildNumber: 2_000_042,
      state: 'RELEASE_LIFECYCLE_STATE_PUBLISHED',
    },
  ];

  it('selects highest exact store builds from tags proven data-only equivalent to release HEAD', () => {
    expect(
      selectReleaseCandidateFromEquivalentTags(
        [
          'build-ios-v2.1.0-41-aaaaaaaaaaaa',
          'build-ios-v2.1.0-42-bbbbbbbbbbbb',
          'build-android-v2.1.0-2000041-cccccccccccc',
          'build-android-v2.1.0-2000042-dddddddddddd',
        ],
        acceptedBuilds,
        '2.1.0',
      ),
    ).toEqual({
      ios: { platform: 'ios', version: '2.1.0', buildNumber: 42, shortFp: 'bbbbbbbbbbbb' },
      android: { platform: 'android', version: '2.1.0', buildNumber: 2_000_042, shortFp: 'dddddddddddd' },
    });
  });

  it('blocks when a newer native-equivalent build tag is still pending store acceptance', () => {
    expect(
      selectReleaseCandidateFromEquivalentTags(
        [
          'build-ios-v2.1.0-42-bbbbbbbbbbbb',
          'build-ios-v2.1.0-43-bbbbbbbbbbbb',
          'build-android-v2.1.0-2000042-dddddddddddd',
        ],
        acceptedBuilds,
        '2.1.0',
      ),
    ).toBeNull();
  });
});

describe('selectHighestAcceptedBuildTags', () => {
  const acceptedBuilds = [
    { platform: 'ios' as const, versionString: '2.1.0', buildNumber: 41, state: 'ACCEPTED' },
    { platform: 'ios' as const, versionString: '2.1.0', buildNumber: 42, state: 'READY_FOR_DISTRIBUTION' },
    {
      platform: 'android' as const,
      versionString: null,
      buildNumber: 2_000_042,
      state: 'RELEASE_LIFECYCLE_STATE_PUBLISHED',
    },
  ];

  it('returns highest build tags only when those exact builds are accepted, without claiming HEAD equivalence', () => {
    expect(
      selectHighestAcceptedBuildTags(
        [
          'build-ios-v2.1.0-41-aaaaaaaaaaaa',
          'build-ios-v2.1.0-42-bbbbbbbbbbbb',
          'build-android-v2.1.0-2000042-dddddddddddd',
        ],
        acceptedBuilds,
        '2.1.0',
      ),
    ).toEqual({
      ios: { platform: 'ios', version: '2.1.0', buildNumber: 42, shortFp: 'bbbbbbbbbbbb' },
      android: { platform: 'android', version: '2.1.0', buildNumber: 2_000_042, shortFp: 'dddddddddddd' },
    });
  });

  it('blocks when a newer build tag exists but is still pending store acceptance', () => {
    expect(
      selectHighestAcceptedBuildTags(
        [
          'build-ios-v2.1.0-42-bbbbbbbbbbbb',
          'build-ios-v2.1.0-43-cccccccccccc',
          'build-android-v2.1.0-2000042-dddddddddddd',
        ],
        acceptedBuilds,
        '2.1.0',
      ),
    ).toBeNull();
  });

  it('fails closed when either platform is missing or highest tag is ambiguous', () => {
    expect(selectHighestAcceptedBuildTags(['build-ios-v2.1.0-42-bbbbbbbbbbbb'], acceptedBuilds, '2.1.0')).toBeNull();
    expect(
      selectHighestAcceptedBuildTags(
        [
          'build-ios-v2.1.0-42-bbbbbbbbbbbb',
          'build-ios-v2.1.0-42-cccccccccccc',
          'build-android-v2.1.0-2000042-dddddddddddd',
        ],
        acceptedBuilds,
        '2.1.0',
      ),
    ).toBeNull();
  });
});

describe('bumpPatch', () => {
  it('increments the patch component', () => {
    expect(bumpPatch('2.1.0')).toBe('2.1.1');
    expect(bumpPatch('2.1.9')).toBe('2.1.10');
    expect(bumpPatch('10.20.30')).toBe('10.20.31');
  });

  it('rejects non x.y.z', () => {
    expect(() => bumpPatch('2.1')).toThrow();
    expect(() => bumpPatch('v2.1.0')).toThrow();
  });
});
