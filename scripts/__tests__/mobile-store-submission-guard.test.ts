import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requireSubmissionMergedToMain, selectSubmissionBuildTag } from '../mobile-store-submission-guard';

const IOS_TAG = 'build-ios-v2.7.0-31-aaaaaaaaaaaa';
const ANDROID_TAG = 'build-android-v2.7.0-2000101-bbbbbbbbbbbb';

describe('store submission source guard', () => {
  it('selects exact platform, build and version and rejects missing or ambiguous tags', () => {
    expect(selectSubmissionBuildTag([IOS_TAG, ANDROID_TAG], 'ios', '31', '2.7.0')).toBe(IOS_TAG);
    expect(selectSubmissionBuildTag([IOS_TAG, ANDROID_TAG], 'android', '2000101')).toBe(ANDROID_TAG);
    expect(() => selectSubmissionBuildTag([IOS_TAG], 'ios', '32', '2.7.0')).toThrow('found 0');
    expect(() => selectSubmissionBuildTag([IOS_TAG], 'ios', '31', '2.6.0')).toThrow('found 0');
    expect(() =>
      selectSubmissionBuildTag([IOS_TAG, IOS_TAG.replace('aaaaaaaaaaaa', 'cccccccccccc')], 'ios', '31'),
    ).toThrow('found 2');
    expect(() => selectSubmissionBuildTag([IOS_TAG], 'ios', '31; exit 0')).toThrow('positive');
  });

  it('blocks a unmerged candidate build before merge, then accepts that exact build after merge', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'store-submit-'));
    const git = (...arguments_: string[]) =>
      execFileSync('git', arguments_, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
    try {
      git('init', '--initial-branch=main');
      git('config', 'user.name', 'Submission guard test');
      git('config', 'user.email', 'test@example.com');
      writeFileSync(join(cwd, 'source.txt'), 'main\n');
      git('add', '.');
      git('commit', '-m', 'main');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      git('checkout', '-b', 'feature/native-candidate');
      writeFileSync(join(cwd, 'native.txt'), 'new runtime\n');
      git('add', '.');
      git('commit', '-m', 'native candidate');
      git('tag', IOS_TAG);
      const buildCommit = git('rev-parse', 'HEAD');
      expect(() =>
        requireSubmissionMergedToMain({ platform: 'ios', buildNumber: '31', version: '2.7.0', cwd }),
      ).toThrow('Merge the source into main');
      git('checkout', 'main');
      git('merge', '--no-ff', 'feature/native-candidate', '-m', 'merge candidate');
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      expect(requireSubmissionMergedToMain({ platform: 'ios', buildNumber: '31', version: '2.7.0', cwd })).toEqual({
        buildTag: IOS_TAG,
        buildCommit,
        mainCommit: git('rev-parse', 'HEAD'),
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
