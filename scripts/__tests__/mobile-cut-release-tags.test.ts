import { describe, expect, it } from 'vitest';

import {
  assertAnchorTarget,
  buildTagsAsUploadedBuilds,
  NATIVE_FINGERPRINT_INPUT_PATHS,
  parseAcceptedBuilds,
  parseMarketingVersion,
  readinessOutputForMode,
  resolveExecutionMode,
  shouldSkipAnchorWrites,
} from '../mobile-cut-release-tags';

describe('buildTagsAsUploadedBuilds', () => {
  it('turns only exact build tags for one version into candidate records', () => {
    expect(
      buildTagsAsUploadedBuilds(
        [
          'build-ios-v2.1.0-42-aaaaaaaaaaaa',
          'build-android-v2.1.0-2000042-bbbbbbbbbbbb',
          'build-ios-v2.2.0-43-cccccccccccc',
          'fingerprint-ios-aaaaaaaaaaaaaaaa',
        ],
        '2.1.0',
      ),
    ).toEqual([
      { platform: 'ios', versionString: '2.1.0', buildNumber: 42, state: 'UPLOADED_BUILD_TAG' },
      { platform: 'android', versionString: null, buildNumber: 2_000_042, state: 'UPLOADED_BUILD_TAG' },
    ]);
  });
});

describe('parseAcceptedBuilds', () => {
  it('parses exact platform-qualified store builds', () => {
    expect(
      parseAcceptedBuilds(
        '[{"platform":"ios","versionString":"2.1.0","buildNumber":42,"state":"READY_FOR_DISTRIBUTION"},' +
          '{"platform":"android","versionString":null,"buildNumber":2000042,"state":"RELEASE_LIFECYCLE_STATE_PUBLISHED"}]',
      ),
    ).toEqual([
      { platform: 'ios', versionString: '2.1.0', buildNumber: 42, state: 'READY_FOR_DISTRIBUTION' },
      {
        platform: 'android',
        versionString: null,
        buildNumber: 2_000_042,
        state: 'RELEASE_LIFECYCLE_STATE_PUBLISHED',
      },
    ]);
  });

  it('returns [] for empty, whitespace, undefined, or the empty-array sentinel', () => {
    expect(parseAcceptedBuilds(undefined)).toEqual([]);
    expect(parseAcceptedBuilds('')).toEqual([]);
    expect(parseAcceptedBuilds('   ')).toEqual([]);
    expect(parseAcceptedBuilds('[]')).toEqual([]);
  });

  it('rejects legacy records that could trigger an Android latest-build guess', () => {
    expect(() => parseAcceptedBuilds('[{"versionString":"2.1.0","buildNumber":42}]')).toThrow(
      /Bad accepted-build entry/,
    );
  });

  it.each([
    '[{"platform":"web","versionString":"2.1.0","buildNumber":42,"state":"ACCEPTED"}]',
    '[{"platform":"ios","versionString":null,"buildNumber":42,"state":"ACCEPTED"}]',
    '[{"platform":"android","versionString":null,"buildNumber":null,"state":"PUBLISHED"}]',
    '[{"platform":"android","versionString":null,"buildNumber":"42","state":"PUBLISHED"}]',
    '[{"platform":"android","versionString":null,"buildNumber":0,"state":"PUBLISHED"}]',
    '[{"platform":"android","versionString":null,"buildNumber":42}]',
  ])('rejects malformed exact-build record %s', (raw) => {
    expect(() => parseAcceptedBuilds(raw)).toThrow(/Bad accepted-build entry/);
  });

  it('throws on non-array JSON', () => {
    expect(() => parseAcceptedBuilds('{"versionString":"2.1.0"}')).toThrow(/must be a JSON array/);
  });
});

describe('trusted release HEAD inputs', () => {
  it('accepts only an x.y.z HEAD_VERSION override', () => {
    expect(parseMarketingVersion('2.1.0', 'HEAD_VERSION')).toBe('2.1.0');
    expect(() => parseMarketingVersion('release/next', 'HEAD_VERSION')).toThrow(/HEAD_VERSION must be x.y.z/);
  });

  it('uses the canonical conservative native-input path screen', () => {
    expect(NATIVE_FINGERPRINT_INPUT_PATHS).toEqual([
      'package.json',
      'packages/mobile/package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'packages/mobile/app.config.ts',
      'packages/mobile/eas.json',
      'packages/mobile/fingerprint.config.js',
      'packages/mobile/assets',
      'packages/mobile/locales',
      'packages/mobile/plugins',
      'packages/mobile/modules',
      'packages/mobile/targets',
      'patches',
    ]);
  });
});

describe('assertAnchorTarget', () => {
  it('allows a missing or exact existing anchor', () => {
    expect(() => assertAnchorTarget(null, 'accepted-sha', 'release/ios-v2.1.0-aaaaaaaaaaaa')).not.toThrow();
    expect(() => assertAnchorTarget('accepted-sha', 'accepted-sha', 'release/ios-v2.1.0-aaaaaaaaaaaa')).not.toThrow();
  });

  it('rejects an existing anchor at a different commit', () => {
    expect(() => assertAnchorTarget('wrong-sha', 'accepted-sha', 'release/ios-v2.1.0-aaaaaaaaaaaa')).toThrow(
      /already points to wrong-sha, expected exact accepted build accepted-sha/,
    );
  });
});

describe('CANDIDATE_ONLY entrypoint mode', () => {
  it('emits candidate discovery and suppresses anchor writes even without CHECK_ONLY', () => {
    expect(resolveExecutionMode({ CANDIDATE_ONLY: 'true', CHECK_ONLY: 'false' })).toEqual({
      candidateOnly: true,
      checkOnly: false,
      readinessOutput: 'candidates_found',
      skipAnchorWrites: true,
    });
  });

  it('keeps normal readiness output and allows anchors only when neither no-write mode is active', () => {
    expect(readinessOutputForMode(false)).toBe('release_ready');
    expect(shouldSkipAnchorWrites(true, false)).toBe(true);
    expect(shouldSkipAnchorWrites(false, false)).toBe(false);
  });
});
