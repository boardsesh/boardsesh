import { describe, expect, it } from 'vite-plus/test';
import { previewPullRequestNumber, buildAppPreviewLink } from '../ota-preview-link';

describe('previewPullRequestNumber', () => {
  it('reads the PR number out of a published preview channel', () => {
    expect(previewPullRequestNumber('pr-1')).toBe(1);
    expect(previewPullRequestNumber('pr-3337')).toBe(3337);
  });

  it('rejects anything the preview workflow does not publish', () => {
    for (const channel of ['production', 'preview-1', 'pr-', 'pr-12x', 'PR-12', 'pr-0', 'pr--1', '']) {
      expect(previewPullRequestNumber(channel)).toBeNull();
    }
  });

  it('rejects leading zeros so one PR has exactly one URL', () => {
    // Otherwise /preview/pr-007 and /preview/pr-7 are two pages for one PR — and
    // the mobile whitelist would disagree with this half.
    expect(previewPullRequestNumber('pr-007')).toBeNull();
  });

  it('stays null past the safe-integer range rather than rounding', () => {
    expect(previewPullRequestNumber('pr-99999999999999999999')).toBeNull();
  });
});

describe('buildAppPreviewLink', () => {
  it('emits the three-slash scheme form Expo Router resolves without rescue', () => {
    // Two slashes would put `preview` in the URL host, where Expo Router's prefix
    // stripping drops it. +native-intent.ts normalises that, but don't rely on it.
    expect(buildAppPreviewLink('pr-1234')).toBe('com.boardsesh.app:///preview/pr-1234');
  });
});
