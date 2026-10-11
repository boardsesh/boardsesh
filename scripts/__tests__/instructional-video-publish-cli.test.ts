import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTutorialPublishArgs } from '../instructional-video-publish';

describe('tutorial publisher command boundary', () => {
  it('accepts Vite+ forwarded separators around its documented flags', () => {
    expect(parseTutorialPublishArgs(['--', '--bundle-dir', '.boardsesh/tutorial-videos/final', '--dry-run'])).toEqual({
      bundleDirectory: resolve('.boardsesh/tutorial-videos/final'),
      dryRun: true,
    });
    expect(parseTutorialPublishArgs(['--bundle-dir', '/tmp/reviewed-tutorial'])).toEqual({
      bundleDirectory: '/tmp/reviewed-tutorial',
      dryRun: false,
    });
  });
  it('refuses missing directories and misspelled options before publishing', () => {
    expect(() => parseTutorialPublishArgs(['--', '--dry-run'])).toThrow('Usage');
    expect(() => parseTutorialPublishArgs(['--bundle-dir', '--dry-run'])).toThrow('needs a directory');
    expect(() => parseTutorialPublishArgs(['--bundel-dir', '/tmp/final'])).toThrow('Unknown argument');
  });
});
