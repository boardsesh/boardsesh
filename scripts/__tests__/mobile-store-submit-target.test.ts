import { describe, expect, it } from 'vitest';
import {
  anchoredPlatforms,
  parseLsRemoteTagNames,
  resolveSubmitMode,
  resolveSubmitTarget,
  type TargetRuntime,
} from '../mobile-store-submit-target';

const releaseSha = 'a'.repeat(40);
const olderSha = 'b'.repeat(40);
const iosTag = 'build-ios-v2.7.1-9-abcdef123456';
const androidTag = 'build-android-v2.7.1-2001001-fedcba654321';
const selection = { releaseSha, version: '2.7.1', iosBuildNumber: '9', androidVersionCode: '2001001' };
const runtime: TargetRuntime = {
  appConfigAt: () => "export default {\n  version: '2.7.1',\n};",
  tagNames: () => [iosTag, androidTag, 'build-ios-v2.7.1-10-123456abcdef'],
  tagCommit: () => olderSha,
  isAncestor: () => true,
};

describe('manual store submission authorization', () => {
  it.each(['push', 'schedule', 'pull_request', 'workflow_run'])(
    'refuses %s even when submission is enabled',
    (eventName) => {
      expect(() => resolveSubmitMode({ eventName, requestedAction: 'submit', killSwitch: 'on' })).toThrow(
        'manual dispatch',
      );
    },
  );
  it('requires an explicit submit and honors the emergency stop', () => {
    expect(resolveSubmitMode({ eventName: 'workflow_dispatch', requestedAction: 'plan', killSwitch: '' }).mode).toBe(
      'plan',
    );
    expect(resolveSubmitMode({ eventName: 'workflow_dispatch', requestedAction: 'submit', killSwitch: '' }).mode).toBe(
      'submit',
    );
    expect(
      resolveSubmitMode({ eventName: 'workflow_dispatch', requestedAction: 'submit', killSwitch: ' OFF ' }).mode,
    ).toBe('plan');
    expect(() => resolveSubmitMode({ eventName: 'workflow_dispatch', requestedAction: '', killSwitch: '' })).toThrow();
  });
});

describe('exact public-store build selection', () => {
  it('selects the requested older build even when a newer build exists', () => {
    expect(resolveSubmitTarget(runtime, selection)).toEqual({
      ...selection,
      iosBuildTag: iosTag,
      androidBuildTag: androidTag,
    });
  });
  it.each([
    { releaseSha: '' },
    { releaseSha: 'main' },
    { version: '' },
    { version: '2.7.2' },
    { iosBuildNumber: '' },
    { iosBuildNumber: 'latest' },
    { androidVersionCode: '0' },
  ])('rejects missing or mismatched exact inputs: %j', (invalid) => {
    expect(() => resolveSubmitTarget(runtime, { ...selection, ...invalid })).toThrow();
  });
  it('rejects a source outside main and build sources outside the selected release', () => {
    expect(() => resolveSubmitTarget({ ...runtime, isAncestor: () => false }, selection)).toThrow('main history');
    expect(() =>
      resolveSubmitTarget({ ...runtime, isAncestor: (_sha, descendant) => descendant !== releaseSha }, selection),
    ).toThrow('not contained');
  });
  it('refuses missing and ambiguous immutable build tags', () => {
    expect(() => resolveSubmitTarget({ ...runtime, tagNames: () => [iosTag] }, selection)).toThrow('found 0');
    expect(() =>
      resolveSubmitTarget(
        { ...runtime, tagNames: () => [iosTag, androidTag, 'build-ios-v2.7.1-9-fedcba654321'] },
        selection,
      ),
    ).toThrow('found 2');
  });
  it('peels tag names once and anchors only the exact selected version', () => {
    expect(parseLsRemoteTagNames(`${releaseSha}\trefs/tags/${iosTag}\n${olderSha}\trefs/tags/${iosTag}^{}\n`)).toEqual([
      iosTag,
    ]);
    expect(
      anchoredPlatforms(
        ['release/ios-v2.7.1-abcdef123456', 'release/android-v2.7.2-fedcba654321', 'release/native-baseline'],
        '2.7.1',
      ),
    ).toEqual({ ios: true, android: false });
  });
});
